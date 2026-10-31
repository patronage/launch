import { ApplyConflictError, batchReceiptSchema } from "./apply";
import type { ApplyPreflight, BatchReceipt } from "./apply";
import type { WordPressRequestLog } from "./logging";
import {
  ApplyValidationError,
  operationSentence,
  parseApplyInput,
} from "./operations";
import type { WriteOperation } from "./operations";
import { draftSentence, parseDraftApplyInput } from "./payload-operations";
import type { DraftOperation } from "./payload-operations";
import { WordPressRequestError } from "./wordpress";

// This module is deliberately package-free: it names no codemode import and no
// `cloudflare:workers` binding, so every mapping below stays testable under
// node vitest. The Durable Object hands it the codemode values as they come.
export const RUNTIME_INSTANCE_NAME = "site";
export const PAUSED_MAX_AGE_MS = 86_400_000;

export const APPROVAL_ROUTE =
  /^\/mcp\/approvals\/(?<executionId>[\w-]{1,128})$/u;

// A pending action always carries `wp.apply` or `payload.apply` arguments, but the durable log is
// the only place they live between the pause and the approval, so a shape the
// schema rejects has to summarise as something rather than throw the approval
// page away.
const UNPARSABLE_INTENT = "unparsable apply arguments";

export const approvalPath = (executionId: string): string =>
  `/mcp/approvals/${executionId}`;

// The four keys this Worker writes to its own Durable Object storage for one
// run, beside the codemode durable log the runtime owns. They are named here,
// once, so the paths that end a run delete exactly what the paths that start
// one wrote — none of them is reachable again after the run is terminal.
export const intentKey = (executionId: string): string =>
  `intent:${executionId}`;

export const preflightKey = (executionId: string): string =>
  `preflight:${executionId}`;

export const nonceKey = (executionId: string): string => `nonce:${executionId}`;

export const requesterKey = (executionId: string): string =>
  `requester:${executionId}`;

export const runStorageKeys = (executionId: string): string[] => [
  intentKey(executionId),
  nonceKey(executionId),
  preflightKey(executionId),
  requesterKey(executionId),
];

// The secret that lets the inline approval card act on one run. It is minted
// when a run pauses, handed to the host in the tool result's `_meta` alone,
// and never written anywhere in clear: the Durable Object keeps only its
// SHA-256, so storage — and anything that ever dumps storage — holds nothing
// that can approve a write. It is single-use: a decision consumes it, and a
// run that pauses again is issued a fresh one.
const NONCE_BYTES = 32;

const ENCODER = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const mintNonce = (): string => {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);

  return toHex(bytes);
};

export const hashNonce = async (nonce: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(nonce));

  return toHex(new Uint8Array(digest));
};

// Both arguments are SHA-256 hex of the same fixed length, so the comparison
// runs over every character and tells a wrong guess nothing about how much of
// it was right.
export const sameDigest = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let differences = 0;

  for (let index = 0; index < left.length; index += 1) {
    differences += left.codePointAt(index) === right.codePointAt(index) ? 0 : 1;
  }

  return differences === 0;
};

// The slice of Durable Object storage the approval token needs, named here so
// the token's whole lifecycle is testable without `cloudflare:workers`.
export interface NonceStore {
  delete: (key: string) => Promise<void>;
  read: (key: string) => Promise<string | undefined>;
  write: (key: string, digest: string) => Promise<void>;
}

// Minting replaces whatever the run held, so a run that pauses again has one
// live token and never a growing set.
export const issueRunNonce = async (
  store: NonceStore,
  executionId: string
): Promise<string> => {
  const nonce = mintNonce();
  await store.write(nonceKey(executionId), await hashNonce(nonce));

  return nonce;
};

// Reading the preview does not spend the token. A run with none on record —
// never paused, already decided, already swept, or minted for another run —
// answers false before any digest is compared.
export const verifyRunNonce = async (
  store: NonceStore,
  executionId: string,
  nonce: string
): Promise<boolean> => {
  const stored = await store.read(nonceKey(executionId));

  if (!stored) {
    return false;
  }

  return sameDigest(stored, await hashNonce(nonce));
};

// One decision per pause, in one pass over storage: read, compare, delete. The
// token is gone before the caller acts on the `true`, so a second press of
// Approve and a replayed tool call both find nothing to verify against.
export const consumeRunNonce = async (
  store: NonceStore,
  executionId: string,
  nonce: string
): Promise<boolean> => {
  const key = nonceKey(executionId);
  const stored = await store.read(key);

  if (!stored || !sameDigest(stored, await hashNonce(nonce))) {
    return false;
  }

  await store.delete(key);

  return true;
};

// Every decision retires the run's token, whichever surface made it. The
// browser approval page spends no token of its own, so without this a run that
// pauses again on a second `wp.apply` would still answer to the token minted
// for the first pause.
export const clearRunNonce = (
  store: NonceStore,
  executionId: string
): Promise<void> => store.delete(nonceKey(executionId));

// The runtime knows the execution id before the request origin is in reach, so
// the paused result carries a site-relative path and the MCP handler rewrites
// it against the origin the caller actually used.
export const approvalUrl = (origin: string, executionId: string): string =>
  new URL(approvalPath(executionId), origin).toString();

export interface RunCall {
  connector: string;
  method: string;
  seq: number;
  state: string;
}

export interface PendingSummary {
  connector: string;
  intent: string;
  method: string;
  sentences: string[];
  seq: number;
}

export type ExecuteResult =
  | { calls: RunCall[]; result: unknown; status: "complete" }
  | {
      // Where a human can answer this run in a browser. It is the fallback for
      // every client that does not render the inline approval card, and it
      // stays present beside the card so a host that drops `_meta` still has a
      // way to reach the decision.
      approvalUrl?: string;
      executionId: string;
      pending: PendingSummary[];
      status: "paused";
      summary: string;
    }
  | { calls: RunCall[]; error: string; status: "error" };

// One entry of the codemode durable tool log. The runtime reports the same
// entry shape as a run's `calls` and as an execution's `log`, so both read
// through this contract; only the fields this module maps are named.
export interface ToolLogRecord {
  args?: unknown;
  connector: string;
  method: string;
  result?: unknown;
  seq: number;
  state?: string;
}

export interface ProxyPending {
  args: unknown;
  connector: string;
  method: string;
  seq: number;
}

export interface ProxyOutcome {
  calls?: ToolLogRecord[];
  error?: string;
  executionId: string;
  pending?: ProxyPending[];
  result?: unknown;
  status: string;
}

export interface ExecutionRecord {
  error?: string;
  id: string;
  log?: ToolLogRecord[];
  result?: unknown;
  status: string;
}

// The write a paused run is waiting on, named by the connector that asked
// for it: `wp.apply` and `payload.apply` take different operations.
export type PendingOperations =
  | { connector: "payload"; intent: string; operations: DraftOperation[] }
  | { connector: "wp"; intent: string; operations: WriteOperation[] };

export interface RunProblem {
  code: string;
  message: string;
}

// The pending action that failed validation, named by the `seq` the runtime's
// `reject` needs.
export interface PendingApplyProblem extends RunProblem {
  connector: string;
  seq: number;
}

export interface RunView {
  // The receipt of the write one approval authorised, set by `approve` alone
  // and never by a report anybody reads back. See `receiptForSeq`.
  approvedReceipt?: BatchReceipt;
  calls: RunCall[];
  error?: string;
  executionId: string;
  // The one-sentence purpose the model gave `execute`, kept beside the run so
  // the approval page can say what the whole run is for, not just what this
  // one `wp.apply` changes.
  intent?: string;
  pending?: PendingOperations;
  preflight?: ApplyPreflight;
  preflightError?: RunProblem;
  receipt?: BatchReceipt;
  // Set by a decision that named a preview other than the one stored now: a
  // form from an earlier pause, or a preview rebuilt since it was shown.
  // Nothing was decided.
  stalePreview?: true;
  status: "complete" | "error" | "paused" | "running" | "unknown";
}

// What the Durable Object reports over RPC. Cloudflare's RPC types rewrite a
// method's return through `Rpc.Serializable`/`Stubify`, which recurse into
// every property; `pending.operations` carries `wp.apply`'s ACF values, whose
// type is unbounded JSON, so that recursion never terminates and the compiler
// refuses the whole stub (TS2589). The raw operations are read only inside the
// Durable Object, to build the approval preview, so the reported run is the
// view without them and everything else crosses the boundary unchanged.
export type RunReport = Omit<RunView, "pending">;

// What every Durable Object RPC answers with. The value is what the caller
// asked for; `wordpress` is the bounded record of the WordPress requests that
// RPC made on the way to it. They are separate because the record belongs on
// the wide event and never in the model-facing result — `SiteDescription` in
// particular is cached for ten minutes, and a cached body must not carry one
// caller's request log to the next.
export interface RuntimeOutcome<TValue> {
  value: TValue;
  wordpress?: WordPressRequestLog;
}

// The log hands a recorded result back as opaque JSON. A zod parse would
// return zod's own optional shape, which `exactOptionalPropertyTypes` refuses
// for `OperationReceipt.error`, so the value is validated in place and passed
// through as the receipt this Worker itself wrote.
const isBatchReceipt = <T>(value: T): value is T & BatchReceipt =>
  batchReceiptSchema.safeParse(value).success;

// A durable log entry and a pending action each name their connector and
// method, so one predicate answers "is this the write path" for either. The
// Durable Object uses it on the pending action an approval is about to resume.
export const isApplyCall = (call: {
  connector: string;
  method: string;
}): boolean =>
  (call.connector === "wp" || call.connector === "payload") &&
  call.method === "apply";

// Each connector's `apply` validates its own operations.
const parsePendingApply = <T>(connector: string, args: T): PendingOperations =>
  connector === "payload"
    ? { connector, ...parseDraftApplyInput(args) }
    : { connector: "wp", ...parseApplyInput(args) };

const toCalls = (entries: ToolLogRecord[]): RunCall[] =>
  entries.map((entry) => ({
    connector: entry.connector,
    method: entry.method,
    seq: entry.seq,
    state: entry.state ?? "applied",
  }));

const toPendingOperations = <T>(
  connector: string,
  args: T
): PendingOperations => {
  try {
    const input = parsePendingApply(connector, args);

    return input.connector === "payload"
      ? {
          connector: "payload",
          intent: input.intent,
          operations: input.operations,
        }
      : { connector: "wp", intent: input.intent, operations: input.operations };
  } catch {
    return { connector: "wp", intent: UNPARSABLE_INTENT, operations: [] };
  }
};

const pendingSentences = (pending: PendingOperations): string[] =>
  pending.connector === "payload"
    ? pending.operations.map((operation) => draftSentence(operation))
    : pending.operations.map((operation) => operationSentence(operation));

const summarizePending = (action: ProxyPending): PendingSummary => {
  const input = toPendingOperations(action.connector, action.args);

  return {
    connector: action.connector,
    intent: input.intent,
    method: action.method,
    sentences: pendingSentences(input),
    seq: action.seq,
  };
};

// `wp.apply` is `requiresApproval`, so the runtime pauses the run before the
// tool body — and the `parseApplyInput` that opens it — ever runs. A batch the
// schema rejects would otherwise reach a human as a paused run no preview can
// be built for, answerable by nothing but Reject. Running the same validation
// over the pending arguments lets the caller reject the run itself and hand
// the model the validation code. The message is this Worker's own: it names
// field paths and the duplicate-target reason, never WordPress content.
export const invalidPendingApply = (
  outcome: ProxyOutcome
): PendingApplyProblem | undefined => {
  if (outcome.status !== "paused") {
    return undefined;
  }

  const action = (outcome.pending ?? []).find((entry) => isApplyCall(entry));

  if (!action) {
    return undefined;
  }

  try {
    parsePendingApply(action.connector, action.args);

    return undefined;
  } catch (error) {
    return error instanceof ApplyValidationError
      ? {
          code: error.code,
          connector: action.connector,
          message: error.message,
          seq: action.seq,
        }
      : undefined;
  }
};

export const toExecuteResult = (outcome: ProxyOutcome): ExecuteResult => {
  if (outcome.status === "paused") {
    const pending = (outcome.pending ?? []).map(summarizePending);
    const [first] = pending;
    const count = first?.sentences.length ?? 0;
    const noun = count === 1 ? "operation" : "operations";

    return {
      executionId: outcome.executionId,
      pending,
      status: "paused",
      summary: `Paused for approval: ${first?.intent ?? "a write"} (${count} ${noun}).`,
    };
  }

  if (outcome.status === "error") {
    return {
      calls: toCalls(outcome.calls ?? []),
      error: outcome.error ?? "The run failed",
      status: "error",
    };
  }

  return {
    calls: toCalls(outcome.calls ?? []),
    result: outcome.result ?? null,
    status: "complete",
  };
};

export const withApprovalUrl = (
  result: ExecuteResult,
  origin: string
): ExecuteResult => {
  if (result.status !== "paused") {
    return result;
  }

  return { ...result, approvalUrl: approvalUrl(origin, result.executionId) };
};

export const executeSummaryText = (result: ExecuteResult): string => {
  if (result.status === "paused") {
    return result.approvalUrl
      ? `${result.summary} Approve in the card above, or at ${result.approvalUrl}`
      : result.summary;
  }

  if (result.status === "error") {
    return `Run failed: ${result.error}`;
  }

  return `Run complete after ${result.calls.length} connector call(s).`;
};

// The approval page renders this, so an unrecognised failure collapses to a
// fixed sentence rather than the thrown message: only the two error types this
// codebase raises carry text that is safe to show.
export const toRunProblem = <E>(error: E): RunProblem => {
  if (error instanceof ApplyConflictError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof WordPressRequestError) {
    return { code: "wordpress_request_failed", message: error.message };
  }

  return {
    code: "preflight_failed",
    message: "The approval preview could not be built",
  };
};

// "unknown" means the durable log has no such run. A rejected approval and an
// expired paused run both end as `rejected`, and a rollback as `rolled_back`;
// each is a run that ended without applying what it asked for, and each
// carries the runtime's own reason on `error`.
const runStatus = (status: string): RunView["status"] => {
  if (status === "completed") {
    return "complete";
  }

  if (status === "rejected" || status === "rolled_back") {
    return "error";
  }

  if (status === "paused" || status === "error" || status === "running") {
    return status;
  }

  return "unknown";
};

// A script may call wp.apply more than once, so a run can hold an applied
// receipt and, after the resume, a second write that is still pending or that
// failed. The view reports the state of the LATEST write and no earlier one:
// an older receipt beside a pending second write would read as "this run is
// done and here is what it did", which is exactly what the approval page and
// `get_run` must not say. So the latest wp.apply entry alone is consulted, and
// it answers with a receipt only when that entry actually recorded one.
const lastReceipt = (entries: ToolLogRecord[]): BatchReceipt | undefined => {
  const latest = entries.findLast((entry) => isApplyCall(entry));
  const result = latest?.result;

  return isBatchReceipt(result) ? result : undefined;
};

// What ONE approval wrote, named by the `seq` of the pending action it
// resumed. `lastReceipt` cannot answer this: `approve` returns only once the
// resumed run reaches its next stop, so a script with a second `wp.apply` has
// already pushed a newer, resultless pending entry into the log by then and
// the latest apply is no longer the write the human authorised. The seq is
// captured before the resume and looked up here afterwards, so the audit row
// names the write that actually changed WordPress. An entry that failed
// recorded no receipt and answers with none.
export const receiptForSeq = (
  record: ExecutionRecord,
  seq: number
): BatchReceipt | undefined => {
  const entry = (record.log ?? []).find((item) => item.seq === seq);
  const result = entry?.result;

  return isBatchReceipt(result) ? result : undefined;
};

// `intent` is read from this Worker's own storage rather than from the
// codemode record, so the Durable Object passes it in: a run that recorded
// none, or whose keys the terminal cleanup already deleted, simply has none.
export const toRunView = (
  executionId: string,
  record?: ExecutionRecord,
  intent?: string
): RunView => {
  if (!record) {
    return { calls: [], executionId, status: "unknown" };
  }

  const entries = record.log ?? [];

  const view: RunView = {
    calls: toCalls(entries),
    executionId,
    status: runStatus(record.status),
  };

  if (record.error) {
    view.error = record.error;
  }

  if (intent) {
    view.intent = intent;
  }

  const receipt = lastReceipt(entries);

  if (receipt) {
    view.receipt = receipt;
  }

  // A run that ended without answering its approval keeps the pending entry in
  // the log, so only a run still paused offers one for approval.
  const pending =
    view.status === "paused"
      ? entries.find((entry) => isApplyCall(entry) && entry.state === "pending")
      : undefined;

  if (pending) {
    view.pending = toPendingOperations(pending.connector, pending.args);
  }

  return view;
};
