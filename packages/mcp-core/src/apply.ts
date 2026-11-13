import { z } from "zod";

const recordSchema = z.record(z.string(), z.json());
const stringSchema = z.string();

export const PREVIEW_LIMIT = 400;

export interface ReceiptError {
  code: string;
  message: string;
}

// A thumbnail is at most this wide and tall, and this many bytes once decoded.
// The byte cap keeps a full batch of previews (`MAX_OPERATIONS`, a before and
// an after each) inside the 2 MB one Durable Object value may hold.
export const THUMBNAIL_MAX_PIXELS = 320;
export const THUMBNAIL_MAX_BYTES = 24 * 1024;

const THUMBNAIL_PREFIX = "data:image/webp;base64,";
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/u;

// The only image either approval surface ever shows: a small WebP the gateway
// made itself, inline as a `data:` URL. Anything else (another type, a remote
// URL, an oversized body) is not a thumbnail and is never rendered.
export const isThumbnailSrc = (src: string): boolean => {
  if (!src.startsWith(THUMBNAIL_PREFIX)) {
    return false;
  }

  const body = src.slice(THUMBNAIL_PREFIX.length);

  return (
    body.length > 0 &&
    body.length % 4 === 0 &&
    body.length <= Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4 &&
    BASE64_BODY.test(body)
  );
};

// A file shown beside a field value: the facts of the file itself and a
// thumbnail of it. `src` is checked with `isThumbnailSrc` where it is
// rendered, so a snapshot can carry facts without a picture.
export interface SnapshotImage {
  // The file's size in bytes, not the thumbnail's.
  bytes: number;
  height: number;
  // The file's type as read from its bytes.
  mimeType: string;
  sha256: string;
  src: string;
  width: number;
}

export interface FieldSnapshot {
  after: string;
  afterImage?: SnapshotImage;
  before: string;
  beforeImage?: SnapshotImage;
  changed: boolean;
  // How a person reads `path`, such as
  // "Sections › Card grid (row 3) › Cards › row 2 › Title".
  label?: string;
  // A field name, or a row path such as `layout[id=…].cards[id=…].title`.
  path: string;
}

// What a row snapshot shows on the side where the row does not exist.
export const NEW_ROW = "(new row)";
export const REMOVED_ROW = "(removed)";

export const WARNING_LIMIT = 300;

export interface OperationPreflight {
  editUrl: string;
  // Where `editUrl` opens, for the link text. Absent means wp-admin.
  editor?: string;
  fields: FieldSnapshot[];
  modifiedGmt: string;
  operationIndex: number;
  // Where the front end shows the target as it is now, drafts included, for
  // a CMS that has such a link. Offered beside `editUrl`.
  previewUrl?: string;
  sentence: string;
  slug: string;
  target: string;
  // Shown above the operation when approving it changes what the public
  // sees at once: a publish, an unpublish, a file replacement, a trash.
  // Cut at `WARNING_LIMIT` where it is rendered.
  warning?: string;
}

export interface ApplyPreflight {
  intent: string;
  operations: OperationPreflight[];
}

// Names one exact preview: its intent, its operations and the before-snapshots
// they were checked against. The approval page signs it into its form, so a
// decision answers the preview its approver saw and no later one.
export const preflightDigest = async (
  preflight: ApplyPreflight | undefined
): Promise<string> => {
  if (!preflight) {
    return "";
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(preflight))
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const RECEIPT_DETAIL_KEYS = 8;
export const RECEIPT_DETAIL_KEY_LIMIT = 40;

export interface OperationReceipt {
  changed_paths: string[];
  // Facts about what the write made that a caller needs next: a new
  // document's id, a file's URL. At most `RECEIPT_DETAIL_KEYS` entries, each
  // value bounded like a preview value. Never a field value.
  details?: Record<string, string>;
  error?: ReceiptError;
  // The operation kind its connector names, such as `update_post`.
  kind: string;
  // A subset of `changed_paths`: the write landed, but the CMS stored a
  // value it rewrote rather than the one that was requested.
  normalized_paths: string[];
  operation_index: number;
  // `unconfirmed` is never written by a connector: it marks an operation of
  // an interrupted apply that had not reported back when the run stopped, so
  // it may or may not have reached the CMS. See `interruptedReceipt`.
  status: "changed" | "conflict" | "failed" | "unchanged" | "unconfirmed";
  target: string;
  // The target's modified time after the write, as the CMS reports it, so a
  // follow-up write can name it as its expected state.
  updated_at?: string;
  // The version or revision the write created, where the CMS keeps them.
  version_id?: string;
}

export interface BatchReceipt {
  approverOpaque: string;
  executionId: string;
  operations: OperationReceipt[];
  requesterOpaque: string;
  status: "failed" | "partial" | "succeeded";
}

const receiptErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const receiptDetailsSchema = z
  .record(
    z.string().min(1).max(RECEIPT_DETAIL_KEY_LIMIT),
    z.string().max(PREVIEW_LIMIT + 1)
  )
  .refine((details) => Object.keys(details).length <= RECEIPT_DETAIL_KEYS);

const operationReceiptSchema = z.object({
  changed_paths: z.array(z.string()),
  details: receiptDetailsSchema.optional(),
  error: receiptErrorSchema.optional(),
  kind: z.string(),
  normalized_paths: z.array(z.string()),
  operation_index: z.number().int().min(0),
  status: z.enum(["changed", "conflict", "failed", "unchanged", "unconfirmed"]),
  target: z.string(),
  updated_at: z.string().max(64).optional(),
  version_id: z.string().max(64).optional(),
});

// A receipt round-trips through the codemode durable log as opaque JSON, so
// `get_run` and the approval page have to prove one before reporting it as a
// write result. This validates exactly what `applyOperations` returns.
export const batchReceiptSchema = z.object({
  approverOpaque: z.string(),
  executionId: z.string(),
  operations: z.array(operationReceiptSchema),
  requesterOpaque: z.string(),
  status: z.enum(["failed", "partial", "succeeded"]),
});

export class ApplyConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplyConflictError";
  }
}

// Receipts and approval previews carry field values, so every rendered value
// is bounded here: never a whole post body, never an unbounded upstream blob.
export const previewValue = <T>(value: T): string => {
  if (value === undefined || value === null) {
    return "";
  }

  const asString = stringSchema.safeParse(value);
  const text = asString.success ? asString.data : (JSON.stringify(value) ?? "");

  return text.length > PREVIEW_LIMIT
    ? `${text.slice(0, PREVIEW_LIMIT)}…`
    : text;
};

// Receipt details are built through here so they always fit the schema that
// `get_run` and the approval page hold a receipt to: bounded values, a bounded
// number of keys, and nothing empty.
export const receiptDetails = (
  entries: Record<string, number | string | null | undefined>
): Record<string, string> | undefined => {
  const details: Record<string, string> = {};

  for (const [key, value] of Object.entries(entries)) {
    const shown = previewValue(value);

    if (
      shown &&
      key.length > 0 &&
      key.length <= RECEIPT_DETAIL_KEY_LIMIT &&
      Object.keys(details).length < RECEIPT_DETAIL_KEYS
    ) {
      details[key] = shown;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
};

// Readback comparison: an acf key can hold an arbitrary JSON structure, so
// "did the write land" is a value comparison, not an identity one.
export const deepEqual = <A, B>(a: A, b: B): boolean => {
  if (Object.is(a, b)) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }

  const left = recordSchema.safeParse(a);
  const right = recordSchema.safeParse(b);

  if (!(left.success && right.success)) {
    return false;
  }

  const leftKeys = Object.keys(left.data).toSorted();
  const rightKeys = Object.keys(right.data).toSorted();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(left.data[key], right.data[key])
    )
  );
};

// An operation that never reported back is not counted as failed: it may have
// landed. So a batch holding one is `partial` even if nothing is confirmed,
// and only a batch whose every operation reported a failure is `failed`.
export const batchStatus = (
  operations: OperationReceipt[]
): BatchReceipt["status"] => {
  const applied = operations.filter(
    (receipt) => receipt.status === "changed" || receipt.status === "unchanged"
  ).length;

  if (applied === operations.length) {
    return "succeeded";
  }

  const unconfirmed = operations.some(
    (receipt) => receipt.status === "unconfirmed"
  );

  return applied === 0 && !unconfirmed ? "failed" : "partial";
};

// What one approved `apply` has reported so far, written by the runtime as
// each operation settles. It holds receipts only: targets, statuses and paths,
// never a field value and never a token.
export interface ApplyProgress {
  approverOpaque: string;
  executionId: string;
  // Receipts in the order operations settled, which with concurrency is not
  // always their index order.
  operations: OperationReceipt[];
  requesterOpaque: string;
  // The durable log `seq` of the `apply` call this progress belongs to. A
  // script can call `apply` more than once, and only the write that wrote
  // this progress may read it back. Absent on progress stored before it was
  // recorded.
  seq?: number;
  startedAt: number;
  // The approved preview's targets, by operation index, so an operation that
  // never reported can still be named.
  targets: string[];
  total: number;
  updatedAt: number;
}

export const INTERRUPTED_ERROR: ReceiptError = {
  code: "interrupted",
  message:
    "The run stopped before this operation reported back. Check it in the CMS before trying again.",
};

// The receipt an apply would have returned had it finished, rebuilt from its
// progress: every operation that reported keeps its own receipt, and every
// other one in the approved preview reads `unconfirmed`. Its batch status is
// therefore `partial` unless every operation reported.
export const interruptedReceipt = (progress: ApplyProgress): BatchReceipt => {
  const reported = new Map(
    progress.operations.map((receipt) => [receipt.operation_index, receipt])
  );

  const operations: OperationReceipt[] = [];

  for (let index = 0; index < progress.total; index += 1) {
    const receipt = reported.get(index);

    operations.push(
      receipt ?? {
        changed_paths: [],
        error: INTERRUPTED_ERROR,
        kind: "unknown",
        normalized_paths: [],
        operation_index: index,
        status: "unconfirmed",
        target: progress.targets.at(index) ?? `operation ${index + 1}`,
      }
    );
  }

  return {
    approverOpaque: progress.approverOpaque,
    executionId: progress.executionId,
    operations,
    requesterOpaque: progress.requesterOpaque,
    status: batchStatus(operations),
  };
};
