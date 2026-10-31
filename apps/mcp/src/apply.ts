import { z } from "zod";

import { changedPaths, operationSentence, operationTarget } from "./operations";
import type { WriteOperation } from "./operations";
import {
  wordPressErrorMessage,
  WordPressRequestError,
  wpFetch,
} from "./wordpress";
import type {
  JsonObject,
  JsonValue,
  WordPressClient,
  WordPressTelemetry,
  WpFetchResult,
} from "./wordpress";

export const PREVIEW_LIMIT = 400;

const MISSED_PATH_LIMIT = 5;

const ACF_PREFIX = "acf.";

const UNREADABLE_MODIFIED_GMT_CODE = "unreadable_modified_gmt";

// Fixed on purpose: it names no field value and no upstream text. WordPress
// omits `modified_gmt` when the caller cannot read the post in edit context or
// when a filter drops the field, and either way there is nothing to gate on.
const UNREADABLE_MODIFIED_GMT_MESSAGE =
  "WordPress did not report when this post was last modified, so the change cannot be checked against the approval preview";

const recordSchema = z.record(z.string(), z.json());
const stringSchema = z.string();

// WordPress `context=edit` renders an editable field as `{ raw, rendered }`;
// the raw value is the one a write round-trips through.
const editableFieldSchema = z.object({ raw: z.json() });

export interface ReceiptError {
  code: string;
  message: string;
}

export interface FieldSnapshot {
  after: string;
  before: string;
  changed: boolean;
  path: string;
}

export interface OperationPreflight {
  editUrl: string;
  // Where `editUrl` opens, for the link text. Absent means wp-admin.
  editor?: string;
  fields: FieldSnapshot[];
  modifiedGmt: string;
  operationIndex: number;
  sentence: string;
  slug: string;
  target: string;
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

export interface OperationReceipt {
  changed_paths: string[];
  error?: ReceiptError;
  kind: "update_draft" | "update_post";
  // A subset of `changed_paths`: the write landed, but WordPress stored a
  // value it rewrote rather than the one that was requested.
  normalized_paths: string[];
  operation_index: number;
  status: "changed" | "conflict" | "failed" | "unchanged";
  target: string;
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

const operationReceiptSchema = z.object({
  changed_paths: z.array(z.string()),
  error: receiptErrorSchema.optional(),
  kind: z.enum(["update_draft", "update_post"]),
  normalized_paths: z.array(z.string()),
  operation_index: z.number().int().min(0),
  status: z.enum(["changed", "conflict", "failed", "unchanged"]),
  target: z.string(),
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

export const readPath = (
  record: JsonObject,
  path: string
): JsonValue | undefined => {
  if (path.startsWith(ACF_PREFIX)) {
    const acf = recordSchema.safeParse(record.acf);

    return acf.success ? acf.data[path.slice(ACF_PREFIX.length)] : undefined;
  }

  const value = record[path];
  const editable = editableFieldSchema.safeParse(value);

  return editable.success ? editable.data.raw : value;
};

export const requestedValue = (
  operation: WriteOperation,
  path: string
): JsonValue | undefined => {
  if (path.startsWith(ACF_PREFIX)) {
    return operation.acf?.[path.slice(ACF_PREFIX.length)];
  }

  const { fields } = operation;

  if (fields === undefined) {
    return undefined;
  }

  return Object.entries(fields).find(([key]) => key === path)?.[1];
};

export const adminEditUrl = (apiUrl: string, id: number): string =>
  new URL(`/wp-admin/post.php?post=${id}&action=edit`, apiUrl).toString();

// Undefined, never "": an absent revision stamp is the one case the conflict
// gate cannot decide, and collapsing it to a string made every comparison
// below silently pass.
const modifiedGmt = (record: JsonObject): string | undefined => {
  const value = stringSchema.safeParse(record.modified_gmt);

  return value.success ? value.data : undefined;
};

const postSlug = (record: JsonObject): string => {
  const value = stringSchema.safeParse(record.slug);

  return value.success ? value.data : "";
};

const resourcePath = (operation: WriteOperation): string =>
  `/wp-json/wp/v2/${operation.rest_base}/${operation.id}`;

const readRecord = async (
  client: WordPressClient,
  operation: WriteOperation,
  telemetry: WordPressTelemetry
): Promise<JsonObject> => {
  const result = await wpFetch(
    client,
    `${resourcePath(operation)}?context=edit`,
    telemetry
  );

  const parsed = recordSchema.safeParse(result.json);

  if (result.status < 200 || result.status >= 300 || !parsed.success) {
    throw new ApplyConflictError(
      result.errorCode ?? "read_failed",
      wordPressErrorMessage(result.status, result.errorCode) ??
        `Could not read ${operationTarget(operation)}`
    );
  }

  return parsed.data;
};

// Receipts never carry an upstream response body, so an unrecognised failure
// collapses to a fixed sentence rather than the thrown message.
const toReceiptError = <E>(error: E): ReceiptError => {
  if (error instanceof ApplyConflictError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof WordPressRequestError) {
    return { code: "wordpress_request_failed", message: error.message };
  }

  return { code: "unexpected_error", message: "The operation failed" };
};

const preflightRemaining = async (
  client: WordPressClient,
  operations: WriteOperation[],
  telemetry: WordPressTelemetry,
  index: number,
  collected: OperationPreflight[]
): Promise<OperationPreflight[]> => {
  const operation = operations.at(index);

  if (operation === undefined) {
    return collected;
  }

  const record = await readRecord(client, operation, telemetry);
  const current = modifiedGmt(record);

  // Without it the snapshot could not be re-checked before the write, so the
  // preview is refused rather than offered as one a human could approve.
  if (current === undefined) {
    throw new ApplyConflictError(
      UNREADABLE_MODIFIED_GMT_CODE,
      UNREADABLE_MODIFIED_GMT_MESSAGE
    );
  }

  if (
    operation.expected_modified_gmt !== undefined &&
    operation.expected_modified_gmt !== current
  ) {
    throw new ApplyConflictError(
      "stale_expected_modified_gmt",
      `${operationTarget(operation)} was last modified at ${current}`
    );
  }

  const fields = changedPaths(operation).map((path) => {
    const before = readPath(record, path);
    const after = requestedValue(operation, path);

    return {
      after: previewValue(after),
      before: previewValue(before),
      changed: !deepEqual(before, after),
      path,
    };
  });

  collected.push({
    editUrl: adminEditUrl(client.apiUrl, operation.id),
    fields,
    modifiedGmt: current,
    operationIndex: index,
    sentence: operationSentence(operation),
    slug: postSlug(record),
    target: operationTarget(operation),
  });

  return preflightRemaining(
    client,
    operations,
    telemetry,
    index + 1,
    collected
  );
};

export const preflightOperations = async (
  client: WordPressClient,
  intent: string,
  operations: WriteOperation[],
  telemetry: WordPressTelemetry
): Promise<ApplyPreflight> => {
  const results = await preflightRemaining(
    client,
    operations,
    telemetry,
    0,
    []
  );

  return { intent, operations: results };
};

const writeBody = (operation: WriteOperation): JsonObject => {
  const body: JsonObject = {};
  const { fields } = operation;

  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        body[key] = value;
      }
    }
  }

  if (operation.acf !== undefined) {
    body.acf = operation.acf;
  }

  return body;
};

interface ReadbackClassification {
  changed: string[];
  missed: string[];
  normalized: string[];
}

// WordPress rewrites some of what it stores: `sanitize_title` and
// `wp_unique_post_slug` on a slug, KSES filtering of content and title for a
// user without `unfiltered_html`, ACF's own normalisation of a field value.
// A stored value that differs from the request but also from the pre-write
// value is that rewriting — the write landed. Only a stored value still equal
// to the pre-write value means WordPress ignored the payload, which is the
// silent-200 case this readback exists to catch. `before` is the record read
// immediately ahead of the write, and the conflict gate above has already
// proved it is the same revision the approval preview snapshotted.
const classifyReadback = (
  operation: WriteOperation,
  before: JsonObject,
  after: JsonObject
): ReadbackClassification => {
  const changed: string[] = [];
  const missed: string[] = [];
  const normalized: string[] = [];

  for (const path of changedPaths(operation)) {
    const requested = requestedValue(operation, path);
    const previous = readPath(before, path);

    if (deepEqual(previous, requested)) {
      // The request asked for the value the post already held: a no-op, not a
      // change and not a miss.
      continue;
    }

    const stored = readPath(after, path);

    if (deepEqual(stored, requested)) {
      changed.push(path);
    } else if (deepEqual(stored, previous)) {
      missed.push(path);
    } else {
      changed.push(path);
      normalized.push(path);
    }
  }

  return { changed, missed, normalized };
};

// Receipt messages stay bounded: paths only, never values, and never more
// than MISSED_PATH_LIMIT of them.
const missedPathsMessage = (missed: string[]): string => {
  const listed = missed.slice(0, MISSED_PATH_LIMIT);
  const extra = missed.length - listed.length;
  const suffix = extra > 0 ? ` and ${extra} more` : "";

  return `WordPress did not store ${listed.join(", ")}${suffix}`;
};

const applyOne = async (
  client: WordPressClient,
  operation: WriteOperation,
  snapshot: OperationPreflight,
  telemetry: WordPressTelemetry
): Promise<OperationReceipt> => {
  const base: Pick<OperationReceipt, "kind" | "operation_index" | "target"> = {
    kind: "update_post",
    operation_index: snapshot.operationIndex,
    target: snapshot.target,
  };

  // The approval preview is persisted at approval time and the operations
  // arrive at apply time, so nothing else guarantees that snapshot i describes
  // operation i. Everything below reports `snapshot.target` and gates on
  // `snapshot.modifiedGmt` while writing to `operation`'s own resource, so a
  // mismatch has to stop before the first fetch.
  if (snapshot.target !== operationTarget(operation)) {
    return {
      ...base,
      changed_paths: [],
      error: {
        code: "preflight_mismatch",
        message: "The approval preview describes a different target",
      },
      normalized_paths: [],
      status: "failed",
      target: operationTarget(operation),
    };
  }

  let before: JsonObject;

  try {
    before = await readRecord(client, operation, telemetry);
  } catch (error) {
    return {
      ...base,
      changed_paths: [],
      error: toReceiptError(error),
      normalized_paths: [],
      status: "failed",
    };
  }

  const currentModifiedGmt = modifiedGmt(before);

  // The same gate as the preview's: a post whose revision stamp cannot be read
  // is a post whose approval cannot be honoured, so nothing is written.
  if (currentModifiedGmt === undefined) {
    return {
      ...base,
      changed_paths: [],
      error: {
        code: UNREADABLE_MODIFIED_GMT_CODE,
        message: UNREADABLE_MODIFIED_GMT_MESSAGE,
      },
      normalized_paths: [],
      status: "conflict",
    };
  }

  if (currentModifiedGmt !== snapshot.modifiedGmt) {
    return {
      ...base,
      changed_paths: [],
      error: {
        code: "modified_since_preflight",
        message: `${snapshot.target} changed after the approval preview`,
      },
      normalized_paths: [],
      status: "conflict",
    };
  }

  // A rejected fetch, an oversized body, or a non-JSON body (what a PHP fatal
  // inside a save_post hook returns) throws here. That must not destroy the
  // receipt for this operation, nor for the writes that already landed.
  let write: WpFetchResult;

  try {
    write = await wpFetch(client, resourcePath(operation), telemetry, {
      body: JSON.stringify(writeBody(operation)),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    return {
      ...base,
      changed_paths: [],
      error: toReceiptError(error),
      normalized_paths: [],
      status: "failed",
    };
  }

  if (write.status < 200 || write.status >= 300) {
    return {
      ...base,
      changed_paths: [],
      error: {
        code: write.errorCode ?? "write_failed",
        message:
          wordPressErrorMessage(write.status, write.errorCode) ??
          `WordPress rejected the write to ${snapshot.target}`,
      },
      normalized_paths: [],
      status: "failed",
    };
  }

  let after: JsonObject;

  try {
    after = await readRecord(client, operation, telemetry);
  } catch (error) {
    return {
      ...base,
      changed_paths: [],
      error: toReceiptError(error),
      normalized_paths: [],
      status: "failed",
    };
  }

  const readback = classifyReadback(operation, before, after);

  if (readback.missed.length > 0) {
    return {
      ...base,
      changed_paths: readback.changed,
      error: {
        code: "readback_mismatch",
        message: missedPathsMessage(readback.missed),
      },
      normalized_paths: readback.normalized,
      status: "failed",
    };
  }

  return {
    ...base,
    changed_paths: readback.changed,
    normalized_paths: readback.normalized,
    status: readback.changed.length > 0 ? "changed" : "unchanged",
  };
};

export const batchStatus = (
  operations: OperationReceipt[]
): BatchReceipt["status"] => {
  const applied = operations.filter(
    (receipt) => receipt.status === "changed" || receipt.status === "unchanged"
  ).length;

  if (applied === operations.length) {
    return "succeeded";
  }

  return applied === 0 ? "failed" : "partial";
};

const applyRemaining = async (
  client: WordPressClient,
  operations: WriteOperation[],
  preflight: ApplyPreflight,
  telemetry: WordPressTelemetry,
  index: number,
  collected: OperationReceipt[]
): Promise<OperationReceipt[]> => {
  const operation = operations.at(index);

  if (operation === undefined) {
    return collected;
  }

  const snapshot = preflight.operations.at(index);

  if (snapshot === undefined) {
    collected.push({
      changed_paths: [],
      error: {
        code: "missing_preflight",
        message: "No approval preview exists for this operation",
      },
      kind: "update_post",
      normalized_paths: [],
      operation_index: index,
      status: "failed",
      target: operationTarget(operation),
    });
  } else {
    collected.push(await applyOne(client, operation, snapshot, telemetry));
  }

  return applyRemaining(
    client,
    operations,
    preflight,
    telemetry,
    index + 1,
    collected
  );
};

export const applyOperations = async (options: {
  approverOpaque: string;
  client: WordPressClient;
  executionId: string;
  operations: WriteOperation[];
  preflight: ApplyPreflight;
  requesterOpaque: string;
  telemetry: WordPressTelemetry;
}): Promise<BatchReceipt> => {
  const receipts = await applyRemaining(
    options.client,
    options.operations,
    options.preflight,
    options.telemetry,
    0,
    []
  );

  return {
    approverOpaque: options.approverOpaque,
    executionId: options.executionId,
    operations: receipts,
    requesterOpaque: options.requesterOpaque,
    status: batchStatus(receipts),
  };
};
