import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  APPROVAL_APP_META_KEY,
  APPROVAL_APP_URI,
  registerApprovalAppResource,
} from "./approval-app";
import type { ApprovalAppState, ApprovalCardView } from "./approval-app";
import {
  APPROVE_HEADING,
  approvalContent,
  isApprovable,
  NO_RECEIPT_PROBLEM,
  RE_PAUSE_NOTICE,
  renderApprovalFragment,
  renderProblemFragment,
  receiptHeadline,
  renderProgressFragment,
  renderReceiptFragment,
  runEndingProblem,
  writeNotice,
} from "./approval-page";
import { CallerScopeError } from "./caller";
import type { CallerContext } from "./caller";
import {
  recordApprovalDecision,
  recordRun,
  recordUpstreamRequests,
  recordWriteReceipt,
} from "./logging";
import type { McpRequestLogger } from "./logging";
import { ApplyValidationError } from "./operations";
import { approvalUrl, executeSummaryText, withApprovalUrl } from "./run";
import type {
  ExecuteResult,
  RunReport,
  RuntimeOutcome,
  SiteDescription,
} from "./run";
import { UpstreamRequestError } from "./upstream";

// The Durable Object's RPC surface, spelled out here rather than imported as
// `DurableObjectStub<BaseGatewayRuntime>`, so this module names no
// `cloudflare:workers` module even through a type import and stays loadable
// under node vitest. `index.ts` passes the real stub and typecheck proves the
// two agree.
export interface RuntimeApi {
  approve: (
    executionId: string,
    caller: CallerContext,
    previewDigest?: string
  ) => Promise<RuntimeOutcome<RunReport>>;
  // The three nonce RPCs answer with a bare value: none reaches the CMS, so
  // none has a request log to carry back.
  consumeNonce: (executionId: string, nonce: string) => Promise<boolean>;
  describeSite: (
    caller: CallerContext
  ) => Promise<RuntimeOutcome<SiteDescription>>;
  execute: (
    code: string,
    intent: string | undefined,
    caller: CallerContext
  ) => Promise<RuntimeOutcome<ExecuteResult>>;
  getRun: (
    executionId: string,
    caller?: CallerContext
  ) => Promise<RuntimeOutcome<RunReport>>;
  issueNonce: (executionId: string) => Promise<string>;
  reject: (
    executionId: string,
    caller: CallerContext,
    previewDigest?: string
  ) => Promise<RuntimeOutcome<RunReport>>;
  verifyNonce: (executionId: string, nonce: string) => Promise<boolean>;
}

export type RuntimeStub = RuntimeApi;

// What this caller's client said it can render, and therefore which approval
// surfaces a paused run is given.
//
// - `advertised`: the client named the MCP Apps UI extension. It gets the card
//   and the app-only tools, and an armed card gets NO approval URL in text or
//   structured content — the model must not repeat an external link beside the
//   native card.
// - `absent`: the client named its capabilities and the extension was not among
//   them. No app surface at all, and the approval URL is the whole answer.
// - `unknown`: the card and the tools AND the URL. A client that never
//   advertised MCP Apps has promised nothing about tool-result `_meta`, so this
//   is not what an unreadable client gets by default — `index.ts` maps it to
//   `absent` unless `APPROVAL_CARD_FOR_UNKNOWN_CLIENTS` is on, and the URL
//   rides along because such a client may have no card to answer with.
export type ClientAppSupport = "absent" | "advertised" | "unknown";

export interface ToolDeps {
  caller: CallerContext;
  // The origin the caller reached this Worker on, so the paused result can
  // name an absolute approval URL the human can open.
  origin: string;
  // One paragraph per configured connector, describing its sandbox global.
  executeDescriptions: string[];
  stub: RuntimeStub;
}

// `describe_site` answers with the site model or, when the runtime call fails,
// with the reason alone.
interface ToolFailure {
  error: string;
}

type DescribeResult = SiteDescription | ToolFailure;

// The model reads one object keyed by sandbox global: `{ wp: {...},
// payload: {...} }`.
const describeOutput = (value: DescribeResult) =>
  "error" in value
    ? value
    : Object.fromEntries(
        value.map((section) => [section.connector, section.description])
      );

const runCallSchema = z.object({
  connector: z.string(),
  method: z.string(),
  seq: z.number(),
  state: z.string(),
});

const pendingSchema = z.object({
  connector: z.string(),
  intent: z.string(),
  method: z.string(),
  sentences: z.array(z.string()),
  seq: z.number(),
});

// A client that renders only text gets the whole site model, not a sentence
// telling it to read a field it cannot see. The cap keeps a large schema
// summary from filling a model's context; the marker says the rest is in
// `structuredContent`.
const DESCRIBE_TEXT_LIMIT = 20_000;

// One section per connector, keyed by its sandbox global (`wp`, `payload`),
// each that connector's own model of the site. The failure shape shares this
// object, so nothing is required.
const describeOutputSchema = z
  .object({ error: z.string().optional() })
  .catchall(z.json());

const runProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
});

// Also flat. `calls`, `executionId`, and `status` are on every report, the
// failure shape included, so those three are the required keys. The preview
// and the receipt are this Worker's own bounded structures and are declared as
// JSON rather than spelled out twice.
const getRunOutputSchema = z.object({
  calls: z.array(runCallSchema),
  error: z.string().optional(),
  executionId: z.string(),
  intent: z.string().optional(),
  preflight: z.json().optional(),
  preflightError: runProblemSchema.optional(),
  progress: z.json().optional(),
  receipt: z.json().optional(),
  receiptInterrupted: z.boolean().optional(),
  status: z.enum(["complete", "error", "paused", "running", "unknown"]),
  write: z
    .object({
      confirmed: z.number().int(),
      status: z.enum(["failed", "partial", "running", "succeeded"]),
      total: z.number().int(),
    })
    .optional(),
});

// One flat object with a required `status`, so a client that reads only the
// discriminant can branch without knowing the three run shapes apart.
const executeOutputSchema = z.object({
  approvalUrl: z.string().optional(),
  calls: z.array(runCallSchema).optional(),
  error: z.string().optional(),
  executionId: z.string().optional(),
  pending: z.array(pendingSchema).optional(),
  result: z.json().optional(),
  status: z.enum(["complete", "error", "paused"]),
  summary: z.string().optional(),
});

const executeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      "An async JavaScript arrow function that returns the desired result and calls only the documented connector methods."
    ),
  intent: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Optional one-sentence purpose for the whole run; a write must also give its connector's apply its own one-sentence intent."
    ),
});

const EXECUTE_DESCRIPTION = [
  "Run one async JavaScript arrow function in a sandbox with the connector globals described below; return the value the user should receive.",
  "Each connector's apply is its only write call and pauses for human approval in the inline app.",
].join(" ");

const getRunInputSchema = z.object({
  executionId: z.string().trim().min(1).max(128),
});

const decisionInputSchema = z.object({
  approvalToken: z.string().trim().min(1).max(256),
  decision: z.enum(["approve", "reject"]),
  executionId: z.string().trim().min(1).max(128),
});

const progressInputSchema = z.object({
  executionId: z.string().trim().min(1).max(128),
});

type ProgressCardView = ApprovalCardView & { running: boolean };

const previewInputSchema = z.object({
  approvalToken: z.string().trim().min(1).max(256),
  executionId: z.string().trim().min(1).max(128),
});

const textResult = <T>(payload: T, summary: string, isError: boolean) => {
  const result = {
    content: [{ text: summary, type: "text" as const }],
    structuredContent: payload,
  };

  return isError ? { ...result, isError: true } : result;
};

// A client that renders only the text block still has to see what it is being
// asked to approve, so a paused run spells out the operations below its summary.
const executeText = (result: ExecuteResult): string => {
  const summary = executeSummaryText(result);

  if (result.status !== "paused") {
    return summary;
  }

  const sentences = result.pending.flatMap((action) => action.sentences);

  return sentences.length > 0 ? `${summary}\n${sentences.join("\n")}` : summary;
};

// The text block is the description itself, serialised and bounded, because a
// text-only client sees nothing else. A failure has no model to serialise, so
// it keeps the sentence and the reason.
const describeText = (value: DescribeResult): string => {
  if ("error" in value) {
    return `Could not describe the site: ${value.error}`;
  }

  const text = JSON.stringify(describeOutput(value));

  return text.length > DESCRIBE_TEXT_LIMIT
    ? `${text.slice(0, DESCRIBE_TEXT_LIMIT)}\n… truncated at ${DESCRIBE_TEXT_LIMIT} characters; the whole model is in structuredContent.`
    : text;
};

// A rejected approval and an expired paused run both read as `error`, and the
// reason lives on `error`, so the status alone would not say what happened.
// The write is named apart from the script, so a run whose write landed and
// whose script then timed out reads as exactly that, never as a failure.
const runText = (view: RunReport): string => {
  const reason = view.error ? ` — ${view.error}` : "";
  const line = `Run ${view.executionId}: ${view.status}${reason}`;

  if (!view.write) {
    return line;
  }

  const { confirmed, status, total } = view.write;

  const interrupted = view.receiptInterrupted
    ? "; the write was interrupted, so unconfirmed operations may or may not have landed"
    : "";

  return `${line}\nWrite: ${status}, ${confirmed} of ${total} operations confirmed${interrupted}.`;
};

const approvalMeta = (state: ApprovalAppState) => ({
  [APPROVAL_APP_META_KEY]: state,
});

// The card's answer to one call: the fragment `approval-page.ts` rendered and
// escaped, whether the run may still be approved, and the sentence a text-only
// reader gets. `_meta` carries the card state; the fragment never does.
const cardResult = (
  view: ApprovalCardView,
  state: ApprovalAppState,
  isError: boolean
) => ({
  ...textResult(view, view.summary, isError),
  _meta: approvalMeta(state),
});

// The before/after preview a human decides on, rendered from the report the
// Durable Object just built. It is the same fragment the browser page shows,
// from the same function, so the two surfaces cannot drift.
const approvalCardView = (
  report: RunReport,
  executionId: string,
  notice?: string
): ApprovalCardView => {
  const content = approvalContent(report, executionId, notice);

  return {
    canApprove: isApprovable(content),
    executionId,
    html: renderApprovalFragment(content),
    summary: content.problem ? content.problem.message : APPROVE_HEADING,
  };
};

const APPLYING_SUMMARY = "Applying the change…";

// What the card shows once the run is no longer awaiting an answer: the
// receipt of the write this decision authorised, or the reason there is none.
const endingCardView = (
  report: RunReport,
  executionId: string
): ApprovalCardView => {
  if (report.progress) {
    return {
      canApprove: false,
      executionId,
      html: renderProgressFragment(report.progress),
      summary: APPLYING_SUMMARY,
    };
  }

  const ending = runEndingProblem(report);
  const receipt = report.approvedReceipt ?? report.receipt;

  if (ending || !receipt) {
    const problem = ending ?? NO_RECEIPT_PROBLEM;

    return {
      canApprove: false,
      executionId,
      html: renderProblemFragment(executionId, problem),
      summary: problem.message,
    };
  }

  return {
    canApprove: false,
    executionId,
    html: renderReceiptFragment(receipt, writeNotice(report)),
    summary: receiptHeadline(receipt),
  };
};

const problemCardView = (
  executionId: string,
  code: string,
  message: string,
  fallbackUrl?: string
): ApprovalCardView => ({
  canApprove: false,
  executionId,
  html: renderProblemFragment(executionId, { code, message }, fallbackUrl),
  summary: message,
});

// Said to a card whose token does not match the run. It names nothing about
// the run and nothing about how close the guess was.
const INVALID_TOKEN_MESSAGE =
  "This approval card can no longer answer this run. Open the approval link instead.";

const invalidTokenResult = (executionId: string) =>
  cardResult(
    problemCardView(
      executionId,
      "invalid_approval_token",
      INVALID_TOKEN_MESSAGE
    ),
    { executionId, status: "error", summary: INVALID_TOKEN_MESSAGE },
    true
  );

const decisionState = (
  decision: "approve" | "reject",
  report: RunReport
): ApprovalAppState => {
  if (decision === "reject") {
    return {
      executionId: report.executionId,
      status: "denied",
      summary: "Denied. No CMS change was made.",
    };
  }

  // The write decides this, not the script: a write that succeeded and a
  // script that timed out afterwards is still an approved, finished change.
  const receipt = report.approvedReceipt ?? report.receipt;

  if (receipt?.status === "succeeded" && !report.receiptInterrupted) {
    return {
      executionId: report.executionId,
      status: "approved",
      summary: "Approved. The CMS change finished.",
    };
  }

  if (receipt) {
    return {
      executionId: report.executionId,
      status: "error",
      summary: `Approved. ${receiptHeadline(receipt)}.`,
    };
  }

  return {
    executionId: report.executionId,
    status: "error",
    summary: "Approved, but the CMS did not complete the operation.",
  };
};

// What a caller is told when the failure is not one this Worker wrote. An
// unrecognised message can be a platform or upstream sentence carrying a host,
// an address, or a body fragment; the wide event keeps the class name instead.
const OPAQUE_TOOL_ERROR = "The runtime failed; see the wide event for details";
const UNNAMED_ERROR = "unknown";
const MAX_ERROR_NAME = 64;

// The three failures whose messages this Worker composed itself, matched by
// name rather than by `instanceof`: an error thrown inside the Durable Object
// reaches the Worker through Cloudflare's RPC as a plain `Error` that keeps the
// original `name` and `message`, so an instance check would discard exactly the
// guidance these classes exist to carry. Reading `.name` off the classes keeps
// the list honest if one is ever renamed.
const RETAINED_ERROR_NAMES: ReadonlySet<string> = new Set([
  ApplyValidationError.name,
  CallerScopeError.name,
  UpstreamRequestError.name,
]);

const errorName = (error: Error): string => {
  const name = error.name.replaceAll(/[^A-Za-z0-9_]/gu, "");

  return name.slice(0, MAX_ERROR_NAME) || UNNAMED_ERROR;
};

interface ToolFailureReport {
  message: string;
  name: string;
}

const toolFailure = <E>(error: E): ToolFailureReport => {
  if (!(error instanceof Error)) {
    return { message: OPAQUE_TOOL_ERROR, name: UNNAMED_ERROR };
  }

  const name = errorName(error);

  return {
    message: RETAINED_ERROR_NAMES.has(name) ? error.message : OPAQUE_TOOL_ERROR,
    name,
  };
};

const withToolLog = async <T>(
  tool: string,
  log: McpRequestLogger,
  operation: () => Promise<T>,
  onError: (message: string) => T
): Promise<{ failed: boolean; value: T }> => {
  const startedAt = Date.now();
  log.set({ mcp: { outcome: "pending", tool } });

  try {
    const value = await operation();
    log.set({
      mcp: { durationMs: Date.now() - startedAt, outcome: "success" },
    });

    return { failed: false, value };
  } catch (error) {
    const failure = toolFailure(error);
    log.setLevel("error");
    log.set({
      mcp: {
        durationMs: Date.now() - startedAt,
        errorName: failure.name,
        outcome: "error",
      },
    });

    return { failed: true, value: onError(failure.message) };
  }
};

// One token per pause. Minting is allowed to fail: the paused result already
// carries the approval URL, so a run whose card cannot be armed is simply a
// run answered on the standalone page. The failure is named on the wide event
// rather than swallowed, because a token that never mints is invisible
// otherwise.
const pendingCardState = async (
  deps: ToolDeps,
  log: McpRequestLogger,
  executionId: string
): Promise<ApprovalAppState> => {
  try {
    return {
      approvalToken: await deps.stub.issueNonce(executionId),
      executionId,
      status: "pending",
    };
  } catch (error) {
    log.set({ mcp: { errorName: toolFailure(error).name } });

    return {
      executionId,
      status: "error",
      summary:
        "Inline approval could not be armed for this run. Use the approval link instead.",
    };
  }
};

interface ApprovalDecisionAnswer {
  state: ApprovalAppState;
  view: ApprovalCardView;
}

type DecisionOutcome =
  | { answer: ApprovalDecisionAnswer; ok: true }
  | { message: string; ok: false };

// A decision that threw left the run paused and its token already spent, so
// the card would be dead — and on a client that was given no approval link,
// nothing else could answer the run. A fresh token is minted for the pause
// that is still open, and the browser route is named beside the failure.
const failedDecisionAnswer = async (
  deps: ToolDeps,
  log: McpRequestLogger,
  executionId: string,
  message: string
): Promise<ApprovalDecisionAnswer> => ({
  state: await pendingCardState(deps, log, executionId),
  view: problemCardView(
    executionId,
    "decision_failed",
    message,
    approvalUrl(deps.origin, executionId)
  ),
});

// Exactly what the approval page's POST does, in the same order: the runtime
// call, then the receipt of the write that decision authorised — recorded
// before the branch that decides what to show, so the audit row survives a run
// that pauses again — then whichever face of the run is left.
const answerDecision = async (
  deps: ToolDeps,
  log: McpRequestLogger,
  executionId: string,
  decision: "approve" | "reject"
): Promise<ApprovalDecisionAnswer> => {
  const outcome =
    decision === "approve"
      ? await deps.stub.approve(executionId, deps.caller)
      : await deps.stub.reject(executionId, deps.caller);

  recordUpstreamRequests(log, outcome.wordpress);
  const answered = outcome.value;

  if (answered.approvedReceipt) {
    recordWriteReceipt(log, answered.approvedReceipt);
  }

  if (answered.status !== "paused") {
    return {
      state: decisionState(decision, answered),
      view: endingCardView(answered, executionId),
    };
  }

  // A script may call `wp.apply` twice: the resumed run pauses on the second
  // write, whose preview only exists once `getRun` computes it. A fresh token
  // is minted for that pause, so one pause is still exactly one decision.
  const next = await deps.stub.getRun(executionId, deps.caller);
  recordUpstreamRequests(log, next.wordpress);

  return {
    state: await pendingCardState(deps, log, executionId),
    view: approvalCardView(next.value, executionId, RE_PAUSE_NOTICE),
  };
};

// The two tools the approval card calls and the model cannot: each is declared
// `visibility: ["app"]`, which is what tells a host to keep them out of the
// model's tool list and to refuse a model's call. Provenance rests on that plus
// the one-time token, which only ever reached the host's `_meta`.
const registerApprovalTools = (
  server: McpServer,
  deps: ToolDeps,
  log: McpRequestLogger
): void => {
  registerAppTool(
    server,
    "preview_write",
    {
      _meta: {
        ui: { resourceUri: APPROVAL_APP_URI, visibility: ["app"] },
      },
      // Not read-only and not idempotent: building the preview reads the CMS
      // and stores the preflight the decision is then bound to. It does not
      // spend the approval token — only a decision does — so a card that is
      // reopened can show the run's current state again.
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Return the approval preview for one paused CMS write, rendered as the approval page's own markup. This tool is callable only by the approval app.",
      inputSchema: previewInputSchema,
    },
    async (input) => {
      const { executionId } = input;
      log.set({ mcp: { outcome: "pending", tool: "preview_write" } });

      if (!(await deps.stub.verifyNonce(executionId, input.approvalToken))) {
        log.setLevel("warn");
        log.set({ mcp: { outcome: "error" } });

        return invalidTokenResult(executionId);
      }

      const { failed, value } = await withToolLog<ApprovalCardView>(
        "preview_write",
        log,
        async () => {
          const outcome = await deps.stub.getRun(executionId, deps.caller);
          recordUpstreamRequests(log, outcome.wordpress);

          return outcome.value.status === "paused"
            ? approvalCardView(outcome.value, executionId)
            : endingCardView(outcome.value, executionId);
        },
        (message) => problemCardView(executionId, "preview_failed", message)
      );

      // The token the caller presented is still live, so the card keeps it.
      return cardResult(
        value,
        value.canApprove
          ? {
              approvalToken: input.approvalToken,
              executionId,
              status: "pending",
            }
          : { executionId, status: "error", summary: value.summary },
        failed
      );
    }
  );

  // What the card polls while a decision is applying, and again if the
  // decision call itself was cut off: progress while the write runs, the
  // run's ending once it stops. It changes nothing and reaches no CMS. It
  // takes no token because it shows nothing `get_run` would not — receipts,
  // never field values — and the token is already spent by the decision.
  registerAppTool(
    server,
    "progress_write",
    {
      _meta: {
        ui: { resourceUri: APPROVAL_APP_URI, visibility: ["app"] },
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Return the progress of an approved CMS write, or its result once it has finished. This tool is callable only by the approval app.",
      inputSchema: progressInputSchema,
    },
    async (input) => {
      const { executionId } = input;

      const { failed, value } = await withToolLog<ProgressCardView>(
        "progress_write",
        log,
        async () => {
          const outcome = await deps.stub.getRun(executionId);
          const report = outcome.value;

          return {
            ...endingCardView(report, executionId),
            running: report.write?.status === "running",
          };
        },
        (message) => ({
          ...problemCardView(executionId, "progress_failed", message),
          running: false,
        })
      );

      return textResult(value, value.summary, failed);
    }
  );

  registerAppTool(
    server,
    "decide_write",
    {
      _meta: {
        ui: { resourceUri: APPROVAL_APP_URI, visibility: ["app"] },
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Record the human decision for a pending CMS write. This tool is callable only by the approval app.",
      inputSchema: decisionInputSchema,
    },
    async (input) => {
      const { decision, executionId } = input;
      const startedAt = Date.now();
      log.set({ mcp: { outcome: "pending", tool: "decide_write" } });

      // The token is spent BEFORE the runtime is touched, so a second press of
      // Approve, or a replayed tool call, finds nothing to verify against.
      if (!(await deps.stub.consumeNonce(executionId, input.approvalToken))) {
        log.setLevel("warn");
        log.set({
          mcp: { durationMs: Date.now() - startedAt, outcome: "error" },
        });

        return invalidTokenResult(executionId);
      }

      recordApprovalDecision(log, {
        approverOpaque: deps.caller.subjectOpaque,
        decision,
        executionId,
        source: "mcp_app",
      });

      const { value } = await withToolLog<DecisionOutcome>(
        "decide_write",
        log,
        async () => ({
          answer: await answerDecision(deps, log, executionId, decision),
          ok: true,
        }),
        (message) => ({ message, ok: false })
      );

      if (value.ok) {
        return cardResult(value.answer.view, value.answer.state, false);
      }

      const recovered = await failedDecisionAnswer(
        deps,
        log,
        executionId,
        value.message
      );

      return cardResult(recovered.view, recovered.state, true);
    }
  );
};

// `support` is what the client said it can render; see `ClientAppSupport` for
// what each answer buys. A client that positively advertised without the
// extension gets three ordinary tools, no card resource, no app-only tools,
// and no `_meta` on a paused result: it answers approvals on the standalone
// page, whose URL every paused result then names.
export const registerTools = (
  server: McpServer,
  deps: ToolDeps,
  log: McpRequestLogger,
  support: ClientAppSupport
): void => {
  const apps = support !== "absent";

  const executeConfig = {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      // execute may read a CMS or stage a proposal, but every apply always
      // pauses. Only the app-only decision tool can perform the mutation.
      readOnlyHint: true,
    },
    description: [EXECUTE_DESCRIPTION, ...deps.executeDescriptions].join(" "),
    inputSchema: executeInputSchema,
    outputSchema: executeOutputSchema,
  };

  const runExecute = async (input: z.infer<typeof executeInputSchema>) => {
    const { failed, value } = await withToolLog<ExecuteResult>(
      "execute",
      log,
      async () => {
        const outcome = await deps.stub.execute(
          input.code,
          input.intent,
          deps.caller
        );

        recordUpstreamRequests(log, outcome.wordpress);

        return outcome.value;
      },
      (message) => ({ calls: [], error: message, status: "error" })
    );

    recordRun(log, value);

    const state =
      apps && value.status === "paused"
        ? await pendingCardState(deps, log, value.executionId)
        : undefined;

    // The link is withheld only where the card actually carries the decision:
    // a client that advertised the extension and whose card was armed. A card
    // the Worker could not arm, and a client that advertised nothing, would
    // otherwise be left with no way to approve at all.
    const armed = support === "advertised" && state?.status === "pending";
    const shown = armed ? value : withApprovalUrl(value, deps.origin);
    const result = textResult(shown, executeText(shown), failed);

    return state ? { ...result, _meta: approvalMeta(state) } : result;
  };

  if (apps) {
    registerAppTool(
      server,
      "execute",
      {
        ...executeConfig,
        _meta: { ui: { resourceUri: APPROVAL_APP_URI, visibility: ["model"] } },
      },
      runExecute
    );
  } else {
    server.registerTool("execute", executeConfig, runExecute);
  }

  if (apps) {
    registerApprovalAppResource(server);
    registerApprovalTools(server, deps, log);
  }

  server.registerTool(
    "describe_site",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Describe what each connector can reach, as the signed-in editor sees it: content types, fields and what can be written. Call this before writing code.",
      inputSchema: z.object({}),
      outputSchema: describeOutputSchema,
    },
    async () => {
      const { failed, value } = await withToolLog<DescribeResult>(
        "describe_site",
        log,
        async () => {
          const outcome = await deps.stub.describeSite(deps.caller);
          recordUpstreamRequests(log, outcome.wordpress);

          return outcome.value;
        },
        (message) => ({ error: message })
      );

      return textResult(describeOutput(value), describeText(value), failed);
    }
  );

  server.registerTool(
    "get_run",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Return the status of one execute run and, once it has finished, the write receipts.",
      inputSchema: getRunInputSchema,
      outputSchema: getRunOutputSchema,
    },
    async (input) => {
      const { failed, value } = await withToolLog<RunReport>(
        "get_run",
        log,
        async () => {
          const outcome = await deps.stub.getRun(input.executionId);
          recordUpstreamRequests(log, outcome.wordpress);

          return outcome.value;
        },
        (message) => ({
          calls: [],
          error: message,
          executionId: input.executionId,
          status: "unknown",
        })
      );

      return textResult(value, runText(value), failed);
    }
  );
};
