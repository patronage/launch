import type {
  ApplyPreflight,
  BatchReceipt,
  FieldSnapshot,
  OperationPreflight,
  OperationReceipt,
} from "./apply";
import { approvalPath } from "./run";
import type { RunProblem, RunReport } from "./run";

// This module renders the only human-facing surface this Worker has, so it
// stays package-free: no `cloudflare:workers` binding and no codemode import,
// and every value it prints is escaped here rather than by the caller. The
// page carries no script — its Content-Security-Policy allows none — so the
// inline stylesheet below is the whole of its presentation.
export const APPROVAL_STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#f6f7f9;color:#12161f}
main{max-width:56rem;margin:0 auto;background:#fff;padding:2rem;border-radius:8px;border:1px solid #d8dce4}
h1{font-size:1.4rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:0 0 .25rem}
p.purpose{color:#6b7280;font-size:.95rem;margin:0 0 .5rem}
p.intent{font-size:1.1rem;margin:0 0 1.5rem}
p.run{color:#6b7280;font-size:.85rem;margin:0 0 1rem}
section{border-top:1px solid #e6e9ef;padding-top:1rem;margin-top:1rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0 0}
th,td{border:1px solid #e6e9ef;padding:.4rem .6rem;text-align:left;vertical-align:top;font-size:.9rem;overflow-wrap:anywhere}
td.before{color:#6b7280}
tr.unchanged td{opacity:.55}
.notice{background:#f1f5fd;border:1px solid #b4c6e6;padding:.75rem 1rem;border-radius:6px}
.problem{background:#fdf1f1;border:1px solid #e6b4b4;padding:.75rem 1rem;border-radius:6px}
form{margin-top:1.5rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #12161f;cursor:pointer}
button.approve{background:#12161f;color:#fff}
button.reject{background:#fff;color:#12161f;margin-left:.75rem}
code{font-size:.85rem}`;

const HTTPS_PREFIX = "https://";

const ENCODER = new TextEncoder();
const HEX_TOKEN = /^(?:[0-9a-f]{2})+$/u;
const HEX_PAIRS = /[0-9a-f]{2}/gu;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

// A submitted token that is not lower-case hex of even length is not a
// signature this module ever wrote, and the shape is decided before any secret
// is in play.
const fromHex = (value: string): Uint8Array | undefined => {
  if (!HEX_TOKEN.test(value)) {
    return undefined;
  }

  const pairs = value.match(HEX_PAIRS) ?? [];

  return Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
};

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );

const csrfMessage = (executionId: string, subjectOpaque: string): Uint8Array =>
  ENCODER.encode(`${executionId}.${subjectOpaque}`);

// The token binds one execution to one approver, so a form served to one
// person cannot answer another person's run and a link cannot answer any run
// at all: the secret never leaves the deployment.
export const approvalCsrfToken = async (
  secret: string,
  executionId: string,
  subjectOpaque: string
): Promise<string> => {
  const key = await hmacKey(secret);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    csrfMessage(executionId, subjectOpaque)
  );

  return hex(signature);
};

// WebCrypto compares the two MACs itself, in constant time, rather than this
// module comparing token text: a rejected token must never tell its sender how
// much of a guess was right.
export const verifyApprovalCsrfToken = async (
  secret: string,
  executionId: string,
  subjectOpaque: string,
  token: string
): Promise<boolean> => {
  const signature = fromHex(token);

  if (!signature) {
    return false;
  }

  const key = await hmacKey(secret);

  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    csrfMessage(executionId, subjectOpaque)
  );
};

// What one paused run looks like on either surface. The standalone page and
// the inline card render this same content through `renderApprovalFragment`,
// so neither can offer a decision the other refuses and neither can drift into
// describing the same run differently. Only the page adds the `<form>` below,
// because the card supplies its own buttons over the host bridge.
export interface ApprovalContent {
  executionId: string;
  // What the whole run is for, as the model stated it to `execute`. The
  // preflight's own intent below describes only this one `wp.apply`.
  intent?: string;
  notice?: string;
  preflight?: ApplyPreflight;
  problem?: RunProblem;
}

export interface ApprovalView extends ApprovalContent {
  csrfToken: string;
}

// Said on the second approval of a run whose script calls `wp.apply` twice.
// The standalone page and the inline card show the same sentence, so a person
// who answers one and then the other is told the same thing.
export const RE_PAUSE_NOTICE = "This run needs a further approval.";

export const APPROVE_HEADING = "Approve this change";

const NO_PREVIEW_PROBLEM: RunProblem = {
  code: "no_preview",
  message:
    "This run has nothing to approve: its pending change could not be previewed.",
};

// The one judgement both surfaces make about a paused run: a preflight that
// failed says why, and a paused run with no operations to show must not offer
// approval either, because a parse failure can yield zero operations without
// throwing. A run with a problem stays rejectable and is never approvable.
export const approvalContent = (
  report: RunReport,
  executionId: string,
  notice?: string
): ApprovalContent => {
  const content: ApprovalContent = { executionId };

  if (report.intent !== undefined) {
    content.intent = report.intent;
  }

  if (notice !== undefined) {
    content.notice = notice;
  }

  if (report.preflight) {
    content.preflight = report.preflight;
  }

  if (report.preflightError) {
    content.problem = report.preflightError;
  } else if (!report.preflight || report.preflight.operations.length === 0) {
    content.problem = NO_PREVIEW_PROBLEM;
  }

  return content;
};

// Nothing offers to write a change nobody previewed: a recorded problem and an
// empty preview are the same refusal, and a caller that built its content by
// hand is held to it too.
export const isApprovable = (content: ApprovalContent): boolean =>
  content.problem === undefined &&
  (content.preflight?.operations.length ?? 0) > 0;

const UNKNOWN_RUN_PROBLEM: RunProblem = {
  code: "unknown_run",
  message: "No run with this id is on record.",
};

const RUN_RUNNING_PROBLEM: RunProblem = {
  code: "run_running",
  message: "This run is still working. Reload in a moment.",
};

export const NO_RECEIPT_PROBLEM: RunProblem = {
  code: "no_receipt",
  message: "This run finished without a write receipt.",
};

const RUN_FAILED_MESSAGE = "The run ended without applying its change.";

// Every ending a run can have once it is no longer awaiting an answer, bar the
// receipt: only that one is a success. Both surfaces read it here so neither
// explains the same ending differently.
export const runEndingProblem = (report: RunReport): RunProblem | undefined => {
  if (report.status === "unknown") {
    return UNKNOWN_RUN_PROBLEM;
  }

  if (report.status === "error") {
    return { code: "run_failed", message: report.error ?? RUN_FAILED_MESSAGE };
  }

  if (report.status === "running") {
    return RUN_RUNNING_PROBLEM;
  }

  return undefined;
};

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${APPROVAL_STYLE}</style></head>
<body><main>${body}</main></body></html>`;

const runLine = (executionId: string): string =>
  `<p class="run">Run <code>${escapeHtml(executionId)}</code></p>`;

const problemBlock = (problem: RunProblem): string =>
  `<p class="problem"><strong>${escapeHtml(problem.code)}</strong> ${escapeHtml(problem.message)}</p>`;

// wp-admin links come from `adminEditUrl`, which builds them against the
// configured site URL. Anything else never reaches an `href`: a `javascript:`
// or `data:` target would be the one script this page's CSP cannot stop.
const httpsHref = (value: string): string | undefined =>
  value.startsWith(HTTPS_PREFIX) ? value : undefined;

const renderTarget = (operation: OperationPreflight): string => {
  const href = httpsHref(operation.editUrl);
  const target = escapeHtml(operation.target);

  return href
    ? `<a href="${escapeHtml(href)}">Open ${target} in wp-admin</a>`
    : `<span>${target}</span>`;
};

// Both values arrive already bounded by `previewValue`, so a row prints what
// it was handed and never re-reads the post.
const renderField = (field: FieldSnapshot): string =>
  `<tr class="${field.changed ? "changed" : "unchanged"}">
<th scope="row"><code>${escapeHtml(field.path)}</code></th>
<td class="before">${escapeHtml(field.before)}</td>
<td>${escapeHtml(field.after)}</td></tr>`;

const renderOperation = (operation: OperationPreflight): string => {
  const rows = operation.fields.map(renderField).join("");

  return `<section>
<h2>${escapeHtml(operation.sentence)}</h2>
<p>${renderTarget(operation)} &middot; last modified ${escapeHtml(operation.modifiedGmt)}</p>
<table><thead><tr><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
};

// A preflight problem leaves the run answerable but not approvable: the human
// can still reject it, and nothing offers to write a change nobody previewed.
// This is the whole of what a human is shown about a pending write, and it is
// rendered here once for the browser page and the inline card alike.
export const renderApprovalFragment = (content: ApprovalContent): string => {
  const notice = content.notice
    ? `<p class="notice">${escapeHtml(content.notice)}</p>`
    : "";

  const sections = (content.preflight?.operations ?? [])
    .map(renderOperation)
    .join("");

  const problem = content.problem ? problemBlock(content.problem) : "";

  const purpose = content.intent
    ? `<p class="purpose">Stated purpose of this run: ${escapeHtml(content.intent)}</p>`
    : "";

  return `<h1>${APPROVE_HEADING}</h1>
${runLine(content.executionId)}
${notice}
${purpose}
<p class="intent">${escapeHtml(content.preflight?.intent ?? "")}</p>
${problem}
${sections}`;
};

export const renderApprovalPage = (view: ApprovalView): string => {
  const approve = isApprovable(view)
    ? '<button class="approve" name="decision" type="submit" value="approve">Approve</button>'
    : "";

  const body = `${renderApprovalFragment(view)}
<form method="post" action="${escapeHtml(approvalPath(view.executionId))}">
<input name="csrf" type="hidden" value="${escapeHtml(view.csrfToken)}">
${approve}
<button class="reject" name="decision" type="submit" value="reject">Reject</button>
</form>`;

  return page(APPROVE_HEADING, body);
};

// The end of a run that wrote nothing: an unknown id, a rejection, an expiry,
// a refused form. It offers no decision because there is none left to make.
// `fallbackUrl` is named only where the caller has nothing else left to offer:
// an inline card whose decision failed on a client that was given no approval
// link of its own. The href is guarded like every other one this module prints.
export const renderProblemFragment = (
  executionId: string,
  problem: RunProblem,
  fallbackUrl?: string
): string => {
  const href = fallbackUrl ? httpsHref(fallbackUrl) : undefined;
  const shown = fallbackUrl ? escapeHtml(fallbackUrl) : "";

  const anchor = href
    ? `<a href="${escapeHtml(href)}">${shown}</a>`
    : `<code>${shown}</code>`;

  const fallback = fallbackUrl
    ? `<p class="notice">Answer this run in a browser: ${anchor}</p>`
    : "";

  return `<h1>Nothing to approve</h1>
${runLine(executionId)}
${problemBlock(problem)}
${fallback}`;
};

export const renderProblemPage = (
  executionId: string,
  problem: RunProblem
): string =>
  page("Nothing to approve", renderProblemFragment(executionId, problem));

const renderReceiptRow = (operation: OperationReceipt): string => {
  const problem = operation.error
    ? `${operation.error.code}: ${operation.error.message}`
    : "";

  return `<tr>
<th scope="row"><code>${escapeHtml(operation.target)}</code></th>
<td>${escapeHtml(operation.status)}</td>
<td>${escapeHtml(operation.changed_paths.join(", "))}</td>
<td>${escapeHtml(operation.normalized_paths.join(", "))}</td>
<td>${escapeHtml(problem)}</td></tr>`;
};

// The receipt names both subjects because the requester asked for the write
// and the approver's token performed it.
export const renderReceiptFragment = (receipt: BatchReceipt): string => {
  const rows = receipt.operations.map(renderReceiptRow).join("");

  return `<h1>Result: ${escapeHtml(receipt.status)}</h1>
<p class="run">Run <code>${escapeHtml(receipt.executionId)}</code> &middot; requested by <code>${escapeHtml(receipt.requesterOpaque)}</code> &middot; approved by <code>${escapeHtml(receipt.approverOpaque)}</code></p>
<table><thead><tr><th scope="col">Target</th><th scope="col">Status</th>
<th scope="col">Changed</th><th scope="col">Stored with WordPress normalisation</th>
<th scope="col">Problem</th></tr></thead>
<tbody>${rows}</tbody></table>`;
};

export const renderReceiptPage = (receipt: BatchReceipt): string =>
  page("Change applied", renderReceiptFragment(receipt));
