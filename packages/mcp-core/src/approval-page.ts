import { isThumbnailSrc, THUMBNAIL_MAX_PIXELS, WARNING_LIMIT } from "./apply";
import type {
  ApplyPreflight,
  ApplyProgress,
  BatchReceipt,
  FieldSnapshot,
  OperationPreflight,
  OperationReceipt,
  SnapshotImage,
} from "./apply";
import { approvalPath } from "./run";
import type { RunProblem, RunReport } from "./run";

// This module renders the only human-facing surface this Worker has, so it
// stays package-free: no `cloudflare:workers` binding and no codemode import,
// and every value it prints is escaped here rather than by the caller. The
// page carries no script — its Content-Security-Policy allows none — so the
// inline stylesheet below is the whole of its presentation. The only image it
// shows is a thumbnail the gateway made, inline as a `data:` URL.
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
thead th{white-space:nowrap}
tbody th,tbody td{min-width:5.5rem}
td.before{color:#6b7280}
tr.unchanged td{opacity:.55}
.notice{background:#f1f5fd;border:1px solid #b4c6e6;padding:.75rem 1rem;border-radius:6px}
.problem{background:#fdf1f1;border:1px solid #e6b4b4;padding:.75rem 1rem;border-radius:6px}
.warning{background:#fff8e6;border:1px solid #e6cf8a;padding:.6rem 1rem;border-radius:6px;margin:.5rem 0}
th .path{display:block;color:#6b7280;font-weight:400}
img.thumb{display:block;max-width:10rem;max-height:10rem;width:auto;height:auto;border:1px solid #e6e9ef;border-radius:4px;margin:0 0 .35rem;background:#f6f7f9}
p.file{color:#6b7280;font-size:.8rem;margin:0 0 .35rem}
form{margin-top:1.5rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #12161f;cursor:pointer}
button.approve{background:#12161f;color:#fff}
button.reject{background:#fff;color:#12161f;margin-left:.75rem}
ul.progress{list-style:none;padding-left:0}
ul.progress li{margin:.2rem 0}
ul.progress .status{font-weight:600}
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

const csrfMessage = (
  executionId: string,
  subjectOpaque: string,
  previewDigest: string
): Uint8Array =>
  ENCODER.encode(`${executionId}.${subjectOpaque}.${previewDigest}`);

// The token binds one preview of one execution to one approver, so a form
// served to one person cannot answer another person's run, a link cannot
// answer any run at all (the secret never leaves the deployment), and a form
// cannot answer a later pause of the same run or a preview rebuilt since.
export const approvalCsrfToken = async (
  secret: string,
  executionId: string,
  subjectOpaque: string,
  previewDigest: string
): Promise<string> => {
  const key = await hmacKey(secret);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    csrfMessage(executionId, subjectOpaque, previewDigest)
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
  previewDigest: string,
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
    csrfMessage(executionId, subjectOpaque, previewDigest)
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
  // The `preflightDigest` of the preview this form shows, signed into
  // `csrfToken` and checked against the stored preview when the form is sent.
  previewDigest: string;
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
  // A write that reported back is the run's outcome, whatever the script did
  // after it: a timeout or a throw once the write landed is told beside the
  // receipt (see `writeNotice`), never in place of it.
  if (report.receipt && report.status !== "running") {
    return undefined;
  }

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

export const renderPage = (title: string, body: string): string =>
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

  const preview = httpsHref(operation.previewUrl ?? "");

  const link = href
    ? `<a href="${escapeHtml(href)}">Open ${target} in ${escapeHtml(operation.editor ?? "wp-admin")}</a>`
    : `<span>${target}</span>`;

  // The page as it is before this change, so an approver can see what the
  // rows below belong to.
  return preview
    ? `${link} · <a href="${escapeHtml(preview)}">Preview the current draft</a>`
    : link;
};

const fileSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }

  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
};

const wholeNumber = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

// A file beside a value: its facts always, its picture only when it is the
// one kind of image these surfaces show. The facts are the file's own; the
// drawn size is derived from them and capped, so a snapshot can never ask
// for a large box.
const renderImage = (image: SnapshotImage | undefined): string => {
  if (!image) {
    return "";
  }

  const width = wholeNumber(image.width);
  const height = wholeNumber(image.height);
  const scale = Math.min(1, THUMBNAIL_MAX_PIXELS / Math.max(width, height, 1));

  const picture = isThumbnailSrc(image.src)
    ? `<img class="thumb" alt="" src="${escapeHtml(image.src)}" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}">`
    : "";

  const facts = [
    image.mimeType,
    width && height ? `${width} × ${height}` : "",
    fileSize(wholeNumber(image.bytes)),
    image.sha256 ? `sha256 ${image.sha256.slice(0, 12)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `${picture}<p class="file">${escapeHtml(facts)}</p>`;
};

// A row path reads better as its label; the path stays under it, so what the
// write names is still on the page.
const renderPath = (field: FieldSnapshot): string =>
  field.label
    ? `${escapeHtml(field.label)}<code class="path">${escapeHtml(field.path)}</code>`
    : `<code>${escapeHtml(field.path)}</code>`;

// Both values arrive already bounded by `previewValue`, so a row prints what
// it was handed and never re-reads the post.
const renderField = (field: FieldSnapshot): string =>
  `<tr class="${field.changed ? "changed" : "unchanged"}">
<th scope="row">${renderPath(field)}</th>
<td class="before">${renderImage(field.beforeImage)}${escapeHtml(field.before)}</td>
<td>${renderImage(field.afterImage)}${escapeHtml(field.after)}</td></tr>`;

const renderWarning = (operation: OperationPreflight): string => {
  const warning = operation.warning?.trim() ?? "";

  if (!warning) {
    return "";
  }

  const shown =
    warning.length > WARNING_LIMIT
      ? `${warning.slice(0, WARNING_LIMIT)}…`
      : warning;

  return `<p class="warning" role="note"><strong>Heads up:</strong> ${escapeHtml(shown)}</p>`;
};

// A new document has no modified time yet, so its line names the target only.
const renderModified = (operation: OperationPreflight): string =>
  operation.modifiedGmt
    ? ` &middot; last modified ${escapeHtml(operation.modifiedGmt)}`
    : "";

const renderOperation = (operation: OperationPreflight): string => {
  const rows = operation.fields.map(renderField).join("");

  return `<section>
<h2>${escapeHtml(operation.sentence)}</h2>
${renderWarning(operation)}
<p>${renderTarget(operation)}${renderModified(operation)}</p>
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

export const renderApprovalForm = (view: ApprovalView): string => {
  const approve = isApprovable(view)
    ? '<button class="approve" name="decision" type="submit" value="approve">Approve</button>'
    : "";

  const body = `${renderApprovalFragment(view)}
<form method="post" action="${escapeHtml(approvalPath(view.executionId))}">
<input name="csrf" type="hidden" value="${escapeHtml(view.csrfToken)}">
<input name="preview" type="hidden" value="${escapeHtml(view.previewDigest)}">
${approve}
<button class="reject" name="decision" type="submit" value="reject">Reject</button>
</form>`;

  return body;
};

export const renderApprovalPage = (view: ApprovalView): string =>
  renderPage(APPROVE_HEADING, renderApprovalForm(view));

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
  renderPage("Nothing to approve", renderProblemFragment(executionId, problem));

// What a write made, beside whether it landed: the version it created, the
// target's new modified time, and the connector's own details.
const receiptFacts = (operation: OperationReceipt): [string, string][] => {
  const facts: [string, string][] = Object.entries(operation.details ?? {});

  if (operation.version_id) {
    facts.push(["version", operation.version_id]);
  }

  if (operation.updated_at) {
    facts.push(["updated", operation.updated_at]);
  }

  return facts;
};

const renderReceiptRow = (
  operation: OperationReceipt,
  withFacts: boolean
): string => {
  const problem = operation.error
    ? `${operation.error.code}: ${operation.error.message}`
    : "";

  const facts = withFacts
    ? `<td>${receiptFacts(operation)
        .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
        .join("<br>")}</td>`
    : "";

  return `<tr>
<th scope="row"><code>${escapeHtml(operation.target)}</code></th>
<td>${escapeHtml(operation.status)}</td>
<td>${escapeHtml(operation.changed_paths.join(", "))}</td>
<td>${escapeHtml(operation.normalized_paths.join(", "))}</td>
<td>${escapeHtml(problem)}</td>${facts}</tr>`;
};

// The receipt names both subjects because the requester asked for the write
// and the approver's token performed it.
const confirmed = (operations: OperationReceipt[]): number =>
  operations.filter(
    (operation) =>
      operation.status === "changed" || operation.status === "unchanged"
  ).length;

export const receiptHeadline = (receipt: BatchReceipt): string =>
  `Result: ${receipt.status} (${confirmed(receipt.operations)} of ${receipt.operations.length} operations confirmed)`;

// What a receipt cannot say by itself: that the write stopped before every
// operation reported back, or that the script went on to fail after the write
// landed. The two are worded so neither reads as "nothing happened".
export const writeNotice = (report: RunReport): string | undefined => {
  if (!report.receipt) {
    return undefined;
  }

  if (report.receiptInterrupted) {
    return "The run stopped before every operation reported back. Operations marked unconfirmed may or may not have been written: check them in the CMS before trying them again.";
  }

  if (report.status === "error") {
    const reason = report.error ? `: ${report.error}` : ".";

    return `The change below was applied. The run's script stopped after the write${reason}`;
  }

  return undefined;
};

export const renderReceiptFragment = (
  receipt: BatchReceipt,
  notice?: string
): string => {
  // The details column appears only on a receipt that has any, so a receipt
  // from a connector that reports none reads as it always did.
  const withFacts = receipt.operations.some(
    (operation) => receiptFacts(operation).length > 0
  );

  const rows = receipt.operations
    .map((operation) => renderReceiptRow(operation, withFacts))
    .join("");

  const factsHeading = withFacts ? '<th scope="col">Details</th>' : "";
  const shown = notice ? `<p class="notice">${escapeHtml(notice)}</p>` : "";

  return `<h1>${escapeHtml(receiptHeadline(receipt))}</h1>
${shown}
<p class="run">Run <code>${escapeHtml(receipt.executionId)}</code> &middot; requested by <code>${escapeHtml(receipt.requesterOpaque)}</code> &middot; approved by <code>${escapeHtml(receipt.approverOpaque)}</code></p>
<table><thead><tr><th scope="col">Target</th><th scope="col">Status</th>
<th scope="col">Changed</th><th scope="col">Stored by the CMS</th>
<th scope="col">Problem</th>${factsHeading}</tr></thead>
<tbody>${rows}</tbody></table>`;
};

export const renderReceiptPage = (
  receipt: BatchReceipt,
  notice?: string
): string =>
  renderPage("Change applied", renderReceiptFragment(receipt, notice));

// --- Progress -------------------------------------------------------------
//
// An approved write can take a minute or more on a slow CMS host. Both
// surfaces show it operation by operation instead of a spinner: the browser
// page streams one line per settled operation down the open request, and the
// inline card polls for the fragment below.

export const APPLYING_HEADING = "Applying the change";

export const progressHeadline = (progress: ApplyProgress): string =>
  `${progress.operations.length} of ${progress.total} operations done`;

// One settled operation, as a list item. `position` is its place in the order
// operations finished, which with concurrency is not always index order.
export const renderProgressItem = (
  receipt: OperationReceipt,
  position: number,
  total: number
): string => {
  const problem = receipt.error
    ? ` &middot; ${escapeHtml(receipt.error.code)}: ${escapeHtml(receipt.error.message)}`
    : "";

  return `<li>${position} of ${total}: <code>${escapeHtml(receipt.target)}</code> &middot; <span class="status">${escapeHtml(receipt.status)}</span>${problem}</li>\n`;
};

// The whole progress so far, for a poll or a reload: what has settled, and
// what is still waiting.
export const renderProgressFragment = (progress: ApplyProgress): string => {
  const { total } = progress;

  const settled = progress.operations
    .map((receipt, index) => renderProgressItem(receipt, index + 1, total))
    .join("");

  const done = new Set(
    progress.operations.map((receipt) => receipt.operation_index)
  );

  const waiting = progress.targets
    .filter((_, index) => !done.has(index))
    .map((target) => `<code>${escapeHtml(target)}</code>`)
    .join(", ");

  const rest = waiting ? `<p class="run">Still working on: ${waiting}</p>` : "";

  return `<h1>${APPLYING_HEADING}</h1>
${runLine(progress.executionId)}
<p class="intent">${escapeHtml(progressHeadline(progress))}</p>
<ul class="progress">${settled}</ul>
${rest}`;
};

// A reload of the approval page while the write runs: the same progress, and
// a refresh every two seconds. The refresh is a `<meta>` tag because the page's
// CSP allows no script.
export const renderProgressPage = (progress: ApplyProgress): string =>
  renderPage(APPLYING_HEADING, renderProgressFragment(progress)).replace(
    "<title>",
    '<meta http-equiv="refresh" content="2"><title>'
  );

// The streamed answer to an Approve: the head and the opening of the list go
// out at once, an item follows as each operation settles, and the tail closes
// the list and appends whatever the run ended as.
export const renderStreamHead = (executionId: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(APPLYING_HEADING)}</title><style>${APPROVAL_STYLE}</style></head>
<body><main><h1>${APPLYING_HEADING}</h1>
${runLine(executionId)}
<p class="intent">Each operation is listed here as it finishes. Keep this page open until the result appears below.</p>
<ul class="progress">
`;

export const renderStreamTail = (body: string): string =>
  `</ul>
<section>${body}</section></main></body></html>`;
