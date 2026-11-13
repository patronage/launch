import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";

import { verifyAccess } from "./access";
import { preflightDigest } from "./apply";
import {
  APPLYING_HEADING,
  APPROVE_HEADING,
  escapeHtml,
  approvalContent,
  approvalCsrfToken,
  RE_PAUSE_NOTICE,
  renderApprovalForm,
  renderApprovalPage,
  renderPage,
  renderProblemFragment,
  renderProblemPage,
  renderProgressFragment,
  renderProgressItem,
  renderProgressPage,
  renderReceiptFragment,
  renderStreamHead,
  renderStreamTail,
  runEndingProblem,
  verifyApprovalCsrfToken,
  writeNotice,
} from "./approval-page";
import type { ApprovalView } from "./approval-page";
import type { CallerContext } from "./caller";
import { delay } from "./concurrency";
import type { GatewayEnv } from "./env";
import type { GatewayConnector } from "./gateway-connector";
import {
  recordApprovalDecision,
  recordUpstreamRequests,
  recordWriteReceipt,
  SERVICE_VERSION,
  withMcpRequestLog,
} from "./logging";
import type {
  McpLoggingOptions,
  McpRequestLogger,
  McpWideEvent,
} from "./logging";
import { APPROVAL_ROUTE, approvalPath, RUNTIME_INSTANCE_NAME } from "./run";
import type { RunReport, RuntimeOutcome } from "./run";
import type { BaseGatewayRuntime } from "./runtime";
import { APP_ONLY_TOOLS, registerTools } from "./tools";
import type { ClientAppSupport, RuntimeStub, ToolDeps } from "./tools";

// Access Managed OAuth owns client OAuth. Do not add workers-oauth-provider.

const LOCAL_MCP_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const APPROVAL_TOOL = "approval_page";

// The approval page is served to a browser, not to an MCP client: it must not
// be framed, cached, or allowed to load or run anything of its own, and its
// referrer must never carry the execution id to another origin. The one
// exception is `img-src data:`, for the inline thumbnail of a media change:
// a `data:` image carries no request and no script.
const HTML_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} satisfies Record<string, string>;

// A form field arrives as a string, a File, or nothing at all; both fields the
// decision needs are parsed here, at the boundary, and never after.
const csrfFieldSchema = z.string().min(1).max(256);

// A SHA-256 hex digest, or empty for a run that had no preview to show.
const previewFieldSchema = z.union([
  z.literal(""),
  z.string().regex(/^[a-f0-9]{64}$/u),
]);

const decisionFieldSchema = z.enum(["approve", "reject"]);

// The client capabilities this Worker reads: only whether the MCP Apps
// extension is among them. `z.json()` bounds the values without this module
// having to know the shape of any other extension.
const clientCapabilitiesSchema = z.object({
  extensions: z.record(z.string(), z.json()).optional(),
});

// Both places a stateless deployment can learn what the client can render: the
// per-request envelope of protocol revision 2026-07-28, and the `initialize`
// handshake a 2025-era client sends once. This handler builds a fresh server
// per request and keeps no memory of that handshake, so for every request but
// `initialize` the envelope is the only signal there is.
const clientEnvelopeSchema = z.object({
  method: z.string().optional(),
  params: z
    .object({
      _meta: z
        .object({
          [CLIENT_CAPABILITIES_META_KEY]: clientCapabilitiesSchema.optional(),
        })
        .optional(),
      capabilities: clientCapabilitiesSchema.optional(),
      name: z.string().optional(),
      uri: z.string().optional(),
    })
    .optional(),
});

type ClientEnvelope = z.infer<typeof clientEnvelopeSchema>;

// The longest method or resource identifier the wide event keeps, and the most
// methods it lists for one batch.
const MAX_LOGGED_IDENTIFIER = 128;
const MAX_LOGGED_METHODS = 16;

const boundedIdentifier = (value: string): string =>
  value.length > MAX_LOGGED_IDENTIFIER
    ? `${value.slice(0, MAX_LOGGED_IDENTIFIER)}…`
    : value;

// A resource URI is logged without its query string or fragment, which a
// client could fill with anything; the identifier itself is what a debug
// question needs ("did the host fetch the card?").
const resourceIdentifier = (uri: string): string =>
  boundedIdentifier(uri.split(/[?#]/u, 1)[0] || "unknown");

const INITIALIZE_METHOD = "initialize";

// The opt-in that offers the approval card to clients this Worker cannot read.
// Parsed rather than compared, because a var is a string a deployment writes by
// hand: anything but exactly "true" reads as off.
const approvalCardOverrideSchema = z.enum(["false", "true"]);

const approvalCardOverride = (configured: string | undefined): boolean => {
  const parsed = approvalCardOverrideSchema.safeParse(configured);

  return parsed.success && parsed.data === "true";
};

const advertisesApps = (
  capabilities: z.infer<typeof clientCapabilitiesSchema>
): boolean => Object.hasOwn(capabilities.extensions ?? {}, EXTENSION_ID);

// What this caller's client said it can render. It is read from the request
// body here rather than inside the server factory, because the factory is
// handed the HTTP request and not the JSON-RPC message it carries.
//
// A client that states its capabilities decides the answer outright. A request
// that states none at all — no envelope, and not an `initialize` — reads as
// `unknown`, and `unknown` is NOT a licence to hand out the app surface. The
// approval card's one-time token travels in tool-result `_meta`, and a client
// that never advertised MCP Apps has promised nothing about `_meta`: it may
// put it in front of the model, which could then call the app-only decision
// tool itself and approve a CMS write with no human in the loop.
// `visibility: ["app"]` is honoured by conforming hosts only, so on an unknown
// client neither the token nor the tool hiding can be relied on. Such a client
// gets the browser approval page instead, which nothing but a person can
// answer. `APPROVAL_CARD_FOR_UNKNOWN_CLIENTS` exists because a host proven to
// render the card may not send the envelope; see the README for the risk of
// turning it on.
// Everything this Worker reads from the JSON-RPC body before the MCP handler
// does: what the client can render, the method(s) for the wide event, and
// whether the call is one of the approval card's own tools.
interface McpRequestInfo {
  appToolCall: boolean;
  methods: string[];
  resource?: string;
  support: ClientAppSupport;
}

const readMessages = async (request: Request): Promise<ClientEnvelope[]> => {
  if (request.method !== "POST") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(await request.clone().text());
    const list = Array.isArray(parsed) ? parsed : [parsed];

    return list.flatMap((message) => {
      const envelope = clientEnvelopeSchema.safeParse(message);

      return envelope.success ? [envelope.data] : [];
    });
  } catch {
    return [];
  }
};

const supportOf = (
  envelope: ClientEnvelope | undefined,
  unreadable: ClientAppSupport
): ClientAppSupport => {
  if (!envelope) {
    return unreadable;
  }

  const { method, params } = envelope;

  const stated =
    params?._meta?.[CLIENT_CAPABILITIES_META_KEY] ??
    (method === INITIALIZE_METHOD ? params?.capabilities : undefined);

  if (!stated) {
    return unreadable;
  }

  return advertisesApps(stated) ? "advertised" : "absent";
};

const readMcpRequest = async (
  request: Request,
  cardForUnknownClients: boolean
): Promise<McpRequestInfo> => {
  const unreadable = cardForUnknownClients ? "unknown" : "absent";
  const messages = await readMessages(request);
  // A batch is read by its first message, as a single message always was.
  const [first] = messages;

  const methods = messages
    .flatMap((message) => (message.method ? [message.method] : []))
    .slice(0, MAX_LOGGED_METHODS)
    .map(boundedIdentifier);

  const read = messages.find(
    (message) => message.method === "resources/read" && message.params?.uri
  );

  const appToolCall = messages.some(
    (message) =>
      message.method === "tools/call" &&
      APP_ONLY_TOOLS.some((name) => name === message.params?.name)
  );

  const info: McpRequestInfo = {
    appToolCall,
    methods,
    support: supportOf(first, unreadable),
  };

  if (read?.params?.uri) {
    info.resource = resourceIdentifier(read.params.uri);
  }

  return info;
};

const recordMcpRequest = (
  log: McpRequestLogger,
  info: McpRequestInfo
): void => {
  const [method] = info.methods;

  const mcp: Partial<NonNullable<McpWideEvent["mcp"]>> = {
    transport: "streamable-http",
  };

  if (method) {
    mcp.method = method;
  }

  if (info.methods.length > 1) {
    mcp.methods = info.methods;
  }

  if (info.resource) {
    mcp.resource = info.resource;
  }

  log.set({ mcp });
};

const createServer = (
  info: McpRequestInfo,
  deps: ToolDeps,
  log: McpRequestLogger
): McpServer => {
  // The MCP Apps extension is advertised here, which is what a client reads
  // when it decides whether to negotiate it.
  const server = new McpServer(
    {
      name: "launch-mcp",
      version: SERVICE_VERSION,
    },
    { capabilities: { extensions: { [EXTENSION_ID]: {} } } }
  );

  registerTools(server, deps, log, info.support, info.appToolCall);

  return server;
};

const accessDenied = (reason: string): Response =>
  new Response("Forbidden", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Access-Reason": reason,
    },
    status: 403,
  });

// Caller headers are merged first so `HTML_HEADERS` wins every collision: a
// page may add a header (the 405's `Allow`), never relax the ones that keep it
// out of a frame, out of a cache, and away from a script.
const html = (
  body: string,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  new Response(body, {
    headers: { ...headers, ...HTML_HEADERS },
    status,
  });

const problem = (
  executionId: string,
  code: string,
  message: string,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  html(renderProblemPage(executionId, { code, message }), status, headers);

// One instance per deployment: every caller shares the run log the approval
// page reads, and the stub is obtained per request so no caller's work is
// carried on a handle held across requests. The annotation is the check that
// the Durable Object still answers the surface `tools.ts` was written against.
const runtimeStub = (env: GatewayEnv): RuntimeStub => {
  // SAFETY: a Durable Object binding is typed without its class; the
  // deployment binds GATEWAY_RUNTIME to its BaseGatewayRuntime subclass.
  const namespace =
    env.GATEWAY_RUNTIME as DurableObjectNamespace<BaseGatewayRuntime>;

  return namespace.get(namespace.idFromName(RUNTIME_INSTANCE_NAME));
};

// A preview that could not be built leaves the run rejectable but not
// approvable, so the reason takes the place of the before/after tables. That
// judgement lives in `approvalContent`, which the inline card reads too.
const approvalView = (
  form: ApprovalForm,
  executionId: string,
  report: RunReport,
  notice?: string
): ApprovalView => ({
  ...approvalContent(report, executionId, notice),
  csrfToken: form.csrfToken,
  previewDigest: form.previewDigest,
});

interface ApprovalForm {
  csrfToken: string;
  previewDigest: string;
}

// The form a paused run's page carries: its token is signed over the exact
// preview the page shows, so it can answer that preview and nothing else.
const approvalForm = async (
  secret: string,
  executionId: string,
  subjectOpaque: string,
  report: RunReport
): Promise<ApprovalForm> => {
  const previewDigest = await preflightDigest(report.preflight);

  return {
    csrfToken: await approvalCsrfToken(
      secret,
      executionId,
      subjectOpaque,
      previewDigest
    ),
    previewDigest,
  };
};

// Every ending a run can have once it is no longer awaiting an answer, as a
// page body, so the plain page and the streamed answer to an Approve end the
// same way. A receipt is the outcome whenever there is one, with a notice when
// the write was interrupted or the script failed after it; the rest say, in
// the runtime's own words, that nothing was written. Nothing here records the
// write: only the decision path knows a receipt is new. See `handleDecision`.
interface OutcomeBody {
  body: string;
  refresh?: true;
  status: number;
  title: string;
}

// Said where the page can no longer follow a write that is still running,
// such as the end of a streamed approval that outlasted its wait. The GET page
// refreshes itself; this link is for the page that cannot.
const STILL_RUNNING_NOTICE = (executionId: string): string =>
  `<p class="notice">The change is still being applied. <a href="${escapeHtml(approvalPath(executionId))}">Reload this page</a> to follow it to the end.</p>`;

const outcomeBody = (
  executionId: string,
  report: RunReport,
  log: McpRequestLogger
): OutcomeBody => {
  if (report.status === "unknown") {
    log.set({ mcp: { outcome: "not_found" } });
    const unknown = runEndingProblem(report);

    return {
      body: renderProblemFragment(executionId, {
        code: "unknown_run",
        message: unknown?.message ?? "",
      }),
      status: 404,
      title: "Nothing to approve",
    };
  }

  log.set({ mcp: { outcome: "success" } });

  // An approval still applying: its progress, refreshed until it ends.
  if (report.progress) {
    return {
      body: `${renderProgressFragment(report.progress)}${STILL_RUNNING_NOTICE(executionId)}`,
      refresh: true,
      status: 200,
      title: APPLYING_HEADING,
    };
  }

  const ending = runEndingProblem(report);

  if (ending) {
    return {
      body: renderProblemFragment(executionId, ending),
      status: 200,
      title: "Nothing to approve",
    };
  }

  if (report.receipt) {
    return {
      body: renderReceiptFragment(report.receipt, writeNotice(report)),
      status: 200,
      title: "Change applied",
    };
  }

  return {
    body: renderProblemFragment(executionId, {
      code: "no_receipt",
      message: "This run finished without a write receipt.",
    }),
    status: 200,
    title: "Nothing to approve",
  };
};

const outcomePage = (
  executionId: string,
  report: RunReport,
  log: McpRequestLogger
): Response => {
  const outcome = outcomeBody(executionId, report, log);

  if (outcome.refresh && report.progress) {
    return html(renderProgressPage(report.progress), outcome.status);
  }

  return html(renderPage(outcome.title, outcome.body), outcome.status);
};

const reportPage = async (
  secret: string,
  deps: ToolDeps,
  executionId: string,
  report: RunReport,
  log: McpRequestLogger,
  notice?: string
): Promise<Response> => {
  if (report.status === "paused") {
    log.set({ mcp: { outcome: "success" } });

    const form = await approvalForm(
      secret,
      executionId,
      deps.caller.subjectOpaque,
      report
    );

    return html(
      renderApprovalPage(approvalView(form, executionId, report, notice))
    );
  }

  // Every caller of `reportPage` is a re-render of whatever the runtime
  // already recorded (a GET, or the re-paused branch below re-fetching after
  // a decision), never the decision itself, so the write must not be
  // recorded again here.
  return outcomePage(executionId, report, log);
};

// A body that is not a form is not a decision; it must not become a 500.
const readForm = async (request: Request): Promise<FormData | undefined> => {
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
};

// Every approval-page call to the runtime goes through here, so the CMS
// requests the Durable Object made on the caller's behalf reach the wide event
// on both the GET and the POST — the Worker itself no longer talks to
// the CMS, so this is the only place those records can come from.
const runtimeReport = async (
  log: McpRequestLogger,
  call: Promise<RuntimeOutcome<RunReport>>
): Promise<RunReport> => {
  const outcome = await call;
  recordUpstreamRequests(log, outcome.upstream);

  return outcome.value;
};

const STALE_MESSAGE =
  "This change is not the one you were shown any more. Open the approval page again.";

// What a decision ends as, as a page body: a stale form, the run's outcome,
// or — when the script calls `apply` again — the next approval's form. The
// receipt of the write this decision authorised is recorded first, before
// the branch, so the audit row survives a run that pauses again.
// `approvedReceipt` is the only field that names that write: the report's own
// `receipt` is the latest apply, which on a script that applies twice is the
// second, still-pending write by the time `approve` returns.
const decisionBody = async (
  secret: string,
  deps: ToolDeps,
  executionId: string,
  answered: RunReport,
  log: McpRequestLogger
): Promise<OutcomeBody> => {
  if (answered.stalePreview) {
    log.setLevel("warn");
    log.set({ mcp: { outcome: "error" } });

    return {
      body: renderProblemFragment(executionId, {
        code: "stale_approval",
        message: STALE_MESSAGE,
      }),
      status: 409,
      title: "Nothing to approve",
    };
  }

  if (answered.approvedReceipt) {
    recordWriteReceipt(log, answered.approvedReceipt);
  }

  if (answered.status !== "paused") {
    return outcomeBody(executionId, answered, log);
  }

  // The resumed run paused on a second write, whose preview only exists once
  // `getRun` computes it. Its form is signed over that new preview, so the
  // form just sent cannot answer it.
  const next = await runtimeReport(
    log,
    deps.stub.getRun(executionId, deps.caller)
  );

  if (next.status !== "paused") {
    return outcomeBody(executionId, next, log);
  }

  log.set({ mcp: { outcome: "success" } });

  const form = await approvalForm(
    secret,
    executionId,
    deps.caller.subjectOpaque,
    next
  );

  return {
    body: renderApprovalForm(
      approvalView(form, executionId, next, RE_PAUSE_NOTICE)
    ),
    status: 200,
    title: APPROVE_HEADING,
  };
};

const decide = (
  deps: ToolDeps,
  log: McpRequestLogger,
  executionId: string,
  decision: z.infer<typeof decisionFieldSchema>,
  previewDigest: string
): Promise<RunReport> => {
  if (decision === "approve") {
    return runtimeReport(
      log,
      deps.stub.approve(executionId, deps.caller, previewDigest)
    );
  }

  return runtimeReport(
    log,
    deps.stub.reject(executionId, deps.caller, previewDigest)
  );
};

// How often the streamed answer to an Approve asks the runtime what has
// settled. Each poll is one Durable Object read and no CMS request.
const PROGRESS_POLL_MS = 1500;

// The answer to an Approve, streamed. The page head goes out at once, so the
// browser shows the change being applied instead of a spinner; a line follows
// for each operation as it settles; and the tail is whatever the run ended as.
// Keeping the response open is also what keeps the approval alive: a Worker
// has no wall-clock limit while its client is connected.
//
// The response is marked chunked so the request's wide event is emitted when
// the stream ends, with the receipt on it, and not when the head goes out.
const streamApproval = (
  secret: string,
  deps: ToolDeps,
  executionId: string,
  previewDigest: string,
  log: McpRequestLogger
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (text: string): Promise<void> =>
    writer.write(encoder.encode(text));

  const run = async (): Promise<void> => {
    let settled = false;
    let shown = 0;

    const answer = decide(deps, log, executionId, "approve", previewDigest);

    const stopWaiting = new AbortController();

    const done = (async () => {
      try {
        await answer;
      } catch {
        // Read again below, where a failure becomes the page's ending.
      }

      settled = true;
      stopWaiting.abort();
    })();

    const poll = async (): Promise<void> => {
      await delay(PROGRESS_POLL_MS, stopWaiting.signal);

      if (settled) {
        return;
      }

      // A failed poll costs one line, never the approval.
      try {
        const { value } = await deps.stub.getRun(executionId);
        const settledOps = value.progress?.operations ?? [];
        const total = value.progress?.total ?? settledOps.length;
        const fresh = settledOps.slice(shown);

        if (fresh.length > 0) {
          await write(
            fresh
              .map((receipt, index) =>
                renderProgressItem(receipt, shown + index + 1, total)
              )
              .join("")
          );
          shown += fresh.length;
        }
      } catch {
        // The next poll tries again.
      }

      await poll();
    };

    await write(renderStreamHead(executionId));
    await poll();
    await done;

    let outcome: OutcomeBody;

    try {
      outcome = await decisionBody(
        secret,
        deps,
        executionId,
        await answer,
        log
      );
    } catch {
      log.setLevel("error");
      log.set({ mcp: { outcome: "error" } });
      outcome = {
        body: renderProblemFragment(executionId, {
          code: "decision_failed",
          message:
            "The approval could not be completed. Reload this page to see where the run stands.",
        }),
        status: 500,
        title: "Nothing to approve",
      };
    }

    await write(renderStreamTail(outcome.body));
  };

  // A client that went away only stops the writes, and the approval itself
  // runs to its end in the Durable Object; nothing here may reject unobserved.
  // The stream is still the request's work after the response head has gone,
  // so it is handed to `waitUntil`: otherwise the runtime may cancel it once
  // the client disconnects, before the tail is written and the wide event
  // logged.
  const finish = async (): Promise<void> => {
    try {
      await run();
    } catch {
      // The run is reported from the runtime on the next page load.
    }

    try {
      await writer.close();
    } catch {
      // Already closed by a client that went away.
    }
  };

  const finishing = finish();
  deps.waitUntil?.(finishing);

  return new Response(readable, {
    headers: { ...HTML_HEADERS, "Transfer-Encoding": "chunked" },
    status: 200,
  });
};

const handleDecision = async (
  request: Request,
  secret: string,
  deps: ToolDeps,
  executionId: string,
  log: McpRequestLogger
): Promise<Response> => {
  const form = await readForm(request);
  const submitted = csrfFieldSchema.safeParse(form?.get("csrf"));
  const preview = previewFieldSchema.safeParse(form?.get("preview"));

  if (
    !(
      submitted.success &&
      preview.success &&
      (await verifyApprovalCsrfToken(
        secret,
        executionId,
        deps.caller.subjectOpaque,
        preview.data,
        submitted.data
      ))
    )
  ) {
    log.setLevel("warn");
    log.set({ mcp: { outcome: "error" } });

    return problem(
      executionId,
      "invalid_approval_token",
      "This approval form is no longer valid. Open the approval page again.",
      403
    );
  }

  const decision = decisionFieldSchema.safeParse(form?.get("decision"));

  if (!decision.success) {
    log.set({ mcp: { outcome: "error" } });

    return problem(
      executionId,
      "invalid_decision",
      "Choose Approve or Reject.",
      400
    );
  }

  // The CSRF token has just proved this browser session belongs to
  // `deps.caller`, and the decision field is now known to be one of the two
  // valid choices, so both halves of the decision event are in reach.
  recordApprovalDecision(log, {
    approverOpaque: deps.caller.subjectOpaque,
    decision: decision.data,
    executionId,
  });

  if (decision.data === "approve") {
    return streamApproval(secret, deps, executionId, preview.data, log);
  }

  const answered = await decide(
    deps,
    log,
    executionId,
    decision.data,
    preview.data
  );

  const outcome = await decisionBody(secret, deps, executionId, answered, log);

  return html(renderPage(outcome.title, outcome.body), outcome.status);
};

// GET shows what a human is being asked to approve; POST answers it. Both run
// on the caller Access already verified, and the CSRF token binds the form to
// that caller and that run.
const handleApproval = async (
  request: Request,
  env: GatewayEnv,
  deps: ToolDeps,
  executionId: string,
  log: McpRequestLogger
): Promise<Response> => {
  log.set({ mcp: { outcome: "pending", tool: APPROVAL_TOOL } });
  const secret = env.APPROVAL_CSRF_SECRET;

  if (!secret) {
    log.setLevel("error");
    log.set({ mcp: { outcome: "error" } });

    return problem(
      executionId,
      "approval_unavailable",
      "This deployment has no approval signing secret.",
      500
    );
  }

  if (request.method === "POST") {
    return await handleDecision(request, secret, deps, executionId, log);
  }

  if (request.method !== "GET") {
    log.set({ mcp: { outcome: "error" } });

    return problem(
      executionId,
      "method_not_allowed",
      "Open this approval with GET and answer it with the form.",
      405,
      { Allow: "GET, POST" }
    );
  }

  // The caller is passed so the runtime computes and stores the preview a
  // human approves; without it `getRun` reports the run and nothing more.
  const report = await runtimeReport(
    log,
    deps.stub.getRun(executionId, deps.caller)
  );

  return await reportPage(secret, deps, executionId, report, log);
};

export interface WorkerOptions<
  E extends GatewayEnv = GatewayEnv,
> extends McpLoggingOptions {
  accessKey?: JWTVerifyGetKey;
  // The same connectors the deployment's runtime lists. The Worker uses
  // them only to describe the configured ones in the `execute` tool.
  connectors: readonly GatewayConnector<E>[];
}

const isMcpPath = (pathname: string): boolean =>
  pathname === "/mcp" || pathname.startsWith("/mcp/");

const allowedMcpHostnames = (configured = ""): string[] => {
  const deploymentHosts = configured
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set([...LOCAL_MCP_HOSTS, ...deploymentHosts])];
};

export const createWorker = <E extends GatewayEnv>(
  options: WorkerOptions<E>
) => {
  const { accessKey, connectors, ...loggingOptions } = options;

  return withMcpRequestLog<Record<never, never>, E>(
    async (request, env, ctx, log) => {
      const url = new URL(request.url);

      // Only `/mcp` and the paths beneath it are served. Anything else is
      // answered before Access is checked and is not logged as an MCP request,
      // so scanner probes for `/.env` and the like never read as MCP errors.
      if (!isMcpPath(url.pathname)) {
        return new Response("Not Found", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          status: 404,
        });
      }

      const accessDeps = accessKey ? { getKey: accessKey, log } : { log };
      const access = await verifyAccess(request, env, accessDeps);

      if (!access.ok) {
        return accessDenied(access.reason);
      }

      // The caller is built once, from the verified Access result, and is the
      // only thing that carries the forwarded JWT past this point.
      const caller: CallerContext = {
        subjectOpaque: access.subjectOpaque,
        token: access.token,
      };

      const deps: ToolDeps = {
        caller,
        executeDescriptions: connectors
          .filter((connector) => connector.configured(env))
          .map((connector) => connector.executeDescription),
        origin: url.origin,
        stub: runtimeStub(env),
        waitUntil: (promise) => {
          ctx.waitUntil(promise);
        },
      };

      const started = Date.now();
      // The approval route (`/mcp/approvals/:id`) is answered here, ahead of the
      // MCP handler, on the same verified caller and stub.
      const approvalId = APPROVAL_ROUTE.exec(url.pathname)?.groups?.executionId;
      let response: Response;

      if (approvalId) {
        response = await handleApproval(request, env, deps, approvalId, log);
      } else {
        const info = await readMcpRequest(
          request,
          approvalCardOverride(env.APPROVAL_CARD_FOR_UNKNOWN_CLIENTS)
        );

        recordMcpRequest(log, info);

        const hostnames = allowedMcpHostnames(env.MCP_ALLOWED_HOSTNAMES);

        // A browser `Origin` must name one of the hostnames this endpoint
        // serves. MCP clients that are not browsers send no Origin and are
        // unaffected; a browser client served from localhost still works.
        const handler = createMcpHandler(() => createServer(info, deps, log), {
          allowedHostnames: hostnames,
          allowedOriginHostnames: hostnames,
          route: "/mcp",
        });

        // SAFETY: Evlog's Workers context is the same runtime object supplied by
        // Cloudflare; its public type intentionally declares only waitUntil().
        const executionContext = ctx as ExecutionContext;
        response = await handler(request, env, executionContext);
      }

      const current = log.getContext().mcp;
      let outcome = current?.outcome;

      if (!outcome || outcome === "pending") {
        if (response.status === 404) {
          outcome = "not_found";
        } else if (response.status >= 400) {
          outcome = "error";
        } else {
          outcome = "success";
        }
      }

      log.set({
        mcp: {
          durationMs: current?.durationMs ?? Date.now() - started,
          outcome,
        },
      });

      return response;
    },
    loggingOptions
  );
};
