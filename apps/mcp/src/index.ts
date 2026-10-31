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
  approvalContent,
  approvalCsrfToken,
  RE_PAUSE_NOTICE,
  renderApprovalPage,
  renderProblemPage,
  renderReceiptPage,
  runEndingProblem,
  verifyApprovalCsrfToken,
} from "./approval-page";
import type { ApprovalView } from "./approval-page";
import type { CallerContext } from "./caller";
import {
  recordApprovalDecision,
  recordWordPressRequests,
  recordWriteReceipt,
  withMcpRequestLog,
} from "./logging";
import type { McpLoggingOptions, McpRequestLogger } from "./logging";
import { APPROVAL_ROUTE, RUNTIME_INSTANCE_NAME } from "./run";
import type { RunReport, RuntimeOutcome } from "./run";
import type { WordPressRuntime } from "./runtime";
import { registerTools } from "./tools";
import type { ClientAppSupport, RuntimeStub, ToolDeps } from "./tools";

// Access Managed OAuth owns client OAuth. Do not add workers-oauth-provider.

const LOCAL_MCP_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const APPROVAL_TOOL = "approval_page";

// The approval page is served to a browser, not to an MCP client: it must not
// be framed, cached, or allowed to load or run anything of its own, and its
// referrer must never carry the execution id to another origin.
const HTML_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
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
    })
    .optional(),
});

const INITIALIZE_METHOD = "initialize";

// The opt-in that offers the approval card to clients this Worker cannot read.
// Parsed rather than compared, because a var is a string a deployment writes by
// hand: anything but exactly "true" reads as off.
const approvalCardOverrideSchema = z.enum(["false", "true"]);

const approvalCardOverride = (configured: string): boolean => {
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
// tool itself and approve a WordPress write with no human in the loop.
// `visibility: ["app"]` is honoured by conforming hosts only, so on an unknown
// client neither the token nor the tool hiding can be relied on. Such a client
// gets the browser approval page instead, which nothing but a person can
// answer. `APPROVAL_CARD_FOR_UNKNOWN_CLIENTS` exists because a host proven to
// render the card may not send the envelope; see the README for the risk of
// turning it on.
const clientAppSupport = async (
  request: Request,
  cardForUnknownClients: boolean
): Promise<ClientAppSupport> => {
  const unreadable = cardForUnknownClients ? "unknown" : "absent";

  if (request.method !== "POST") {
    return unreadable;
  }

  try {
    const body = await request.clone().text();
    const envelope = clientEnvelopeSchema.safeParse(JSON.parse(body));

    if (!envelope.success) {
      return unreadable;
    }

    const { method, params } = envelope.data;

    const stated =
      params?._meta?.[CLIENT_CAPABILITIES_META_KEY] ??
      (method === INITIALIZE_METHOD ? params?.capabilities : undefined);

    if (!stated) {
      return unreadable;
    }

    return advertisesApps(stated) ? "advertised" : "absent";
  } catch {
    return unreadable;
  }
};

const createServer = (
  support: ClientAppSupport,
  deps: ToolDeps,
  log: McpRequestLogger
): McpServer => {
  // The MCP Apps extension is advertised here, which is what a client reads
  // when it decides whether to negotiate it.
  const server = new McpServer(
    {
      name: "launch-mcp",
      version: "0.2.0",
    },
    { capabilities: { extensions: { [EXTENSION_ID]: {} } } }
  );

  registerTools(server, deps, log, support);

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
const runtimeStub = (env: Env): RuntimeStub => {
  // SAFETY: cf's generated Env types a Durable Object binding without its
  // class; cloudflare.config.ts binds WORDPRESS_RUNTIME to WordPressRuntime.
  const namespace =
    env.WORDPRESS_RUNTIME as DurableObjectNamespace<WordPressRuntime>;

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

// Every ending a run can have once it is no longer awaiting an answer. Only
// the receipt is a success page; the rest say, in the runtime's own words,
// that nothing was written. Nothing here records the write: this page is
// rendered for a GET and for a decision alike, and only the decision path
// knows the receipt is new. See `handleDecision`.
const outcomePage = (
  executionId: string,
  report: RunReport,
  log: McpRequestLogger
): Response => {
  if (report.status === "unknown") {
    log.set({ mcp: { outcome: "not_found" } });
    const unknown = runEndingProblem(report);

    return problem(executionId, "unknown_run", unknown?.message ?? "", 404);
  }

  log.set({ mcp: { outcome: "success" } });
  const ending = runEndingProblem(report);

  if (ending) {
    return problem(executionId, ending.code, ending.message);
  }

  if (report.receipt) {
    return html(renderReceiptPage(report.receipt));
  }

  return problem(
    executionId,
    "no_receipt",
    "This run finished without a write receipt."
  );
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

// Every approval-page call to the runtime goes through here, so the WordPress
// requests the Durable Object made on the caller's behalf reach the wide event
// on both the GET and the POST — the Worker itself no longer talks to
// WordPress, so this is the only place those records can come from.
const runtimeReport = async (
  log: McpRequestLogger,
  call: Promise<RuntimeOutcome<RunReport>>
): Promise<RunReport> => {
  const outcome = await call;
  recordWordPressRequests(log, outcome.wordpress);

  return outcome.value;
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

  const answered = await decide(
    deps,
    log,
    executionId,
    decision.data,
    preview.data
  );

  if (answered.stalePreview) {
    log.setLevel("warn");
    log.set({ mcp: { outcome: "error" } });

    return problem(
      executionId,
      "stale_approval",
      "This change is not the one you were shown any more. Open the approval page again.",
      409
    );
  }

  // This is the one place a receipt is new, and `approvedReceipt` is the only
  // field that names the write THIS decision authorised: the report's own
  // `receipt` is the latest `wp.apply` in the run, which on a script that
  // calls `wp.apply` twice is the second, still-pending write by the time
  // `approve` returns. Recording happens before the branch that decides which
  // page to render, so the audit row survives a run that pauses again.
  if (answered.approvedReceipt) {
    recordWriteReceipt(log, answered.approvedReceipt);
  }

  if (answered.status !== "paused") {
    return outcomePage(executionId, answered, log);
  }

  // A script may call `wp.apply` twice: the resumed run pauses on the second
  // write, whose preview only exists once `getRun` computes it. Its form is
  // signed over that new preview, so the form just sent cannot answer it.
  const next = await runtimeReport(
    log,
    deps.stub.getRun(executionId, deps.caller)
  );

  return await reportPage(
    secret,
    deps,
    executionId,
    next,
    log,
    RE_PAUSE_NOTICE
  );
};

// GET shows what a human is being asked to approve; POST answers it. Both run
// on the caller Access already verified, and the CSRF token binds the form to
// that caller and that run.
const handleApproval = async (
  request: Request,
  env: Env,
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

export interface WorkerOptions extends McpLoggingOptions {
  accessKey?: JWTVerifyGetKey;
}

const allowedMcpHostnames = (configured: string): string[] => {
  const deploymentHosts = configured
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set([...LOCAL_MCP_HOSTS, ...deploymentHosts])];
};

export const createWorker = (options: WorkerOptions = {}) => {
  const { accessKey, ...loggingOptions } = options;

  return withMcpRequestLog(async (request, env, ctx, log) => {
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

    const url = new URL(request.url);

    const deps: ToolDeps = {
      caller,
      origin: url.origin,
      stub: runtimeStub(env),
    };

    const started = Date.now();
    // The approval route (`/mcp/approvals/:id`) is answered here, ahead of the
    // MCP handler, on the same verified caller and stub.
    const approvalId = APPROVAL_ROUTE.exec(url.pathname)?.groups?.executionId;
    let response: Response;

    if (approvalId) {
      response = await handleApproval(request, env, deps, approvalId, log);
    } else {
      const support = await clientAppSupport(
        request,
        approvalCardOverride(env.APPROVAL_CARD_FOR_UNKNOWN_CLIENTS)
      );

      const handler = createMcpHandler(() => createServer(support, deps, log), {
        allowedHostnames: allowedMcpHostnames(env.MCP_ALLOWED_HOSTNAMES),
        allowedOriginHostnames: "*",
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
  }, loggingOptions);
};

export default createWorker() satisfies ExportedHandler<Env>;
