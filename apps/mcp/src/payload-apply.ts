import { z } from "zod";

import {
  ApplyConflictError,
  batchStatus,
  deepEqual,
  previewValue,
} from "./apply";
import type {
  ApplyPreflight,
  BatchReceipt,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
} from "./apply";
import { payloadErrorMessage, payloadRest } from "./payload";
import {
  draftChangedPaths,
  draftSentence,
  draftTarget,
} from "./payload-operations";
import type { DraftOperation } from "./payload-operations";
import { WordPressRequestError } from "./wordpress";
import type {
  JsonObject,
  WordPressClient,
  WordPressTelemetry,
  WpFetchResult,
} from "./wordpress";

const MISSED_PATH_LIMIT = 5;

const recordSchema = z.record(z.string(), z.json());
const stringSchema = z.string();

export type PayloadAdminUrl = (
  collection: string,
  id: number | string
) => string;

// Every read and write names the draft: a read returns the newest version,
// draft or published, and a write saves a new draft version and leaves the
// published one as it is.
const documentPath = (operation: DraftOperation): string =>
  `/api/${encodeURIComponent(operation.collection)}/${encodeURIComponent(String(operation.id))}?draft=true&depth=0`;

const updatedAt = (record: JsonObject): string | undefined => {
  const value = stringSchema.safeParse(record.updatedAt);

  return value.success ? value.data : undefined;
};

const failed = (result: WpFetchResult, fallback: string): ApplyConflictError =>
  new ApplyConflictError(
    result.status === 404 ? "not_found" : "read_failed",
    result.status === 404 ? fallback : payloadErrorMessage(result)
  );

const readDocument = async (
  client: WordPressClient,
  operation: DraftOperation,
  telemetry: WordPressTelemetry
): Promise<JsonObject> => {
  const result = await payloadRest(client, documentPath(operation), telemetry);
  const parsed = recordSchema.safeParse(result.json);

  if (result.status < 200 || result.status >= 300 || !parsed.success) {
    throw failed(result, `${draftTarget(operation)} was not found`);
  }

  return parsed.data;
};

// Only a collection with drafts keeps the published version apart from the
// one being written. Without drafts, `?draft=true` is ignored and the write
// would go live, so such a document is refused before anything is shown.
const assertDrafts = (record: JsonObject, operation: DraftOperation): void => {
  if (!("_status" in record)) {
    throw new ApplyConflictError(
      "drafts_not_enabled",
      `${operation.collection} has no drafts, so a change there would publish at once`
    );
  }
};

const readStamp = (record: JsonObject, operation: DraftOperation): string => {
  const stamp = updatedAt(record);

  if (stamp === undefined) {
    throw new ApplyConflictError(
      "unreadable_updated_at",
      `Payload did not report when ${draftTarget(operation)} was last updated`
    );
  }

  return stamp;
};

const preflightOne = async (
  client: WordPressClient,
  operation: DraftOperation,
  index: number,
  adminUrl: PayloadAdminUrl,
  telemetry: WordPressTelemetry
): Promise<OperationPreflight> => {
  const record = await readDocument(client, operation, telemetry);
  assertDrafts(record, operation);
  const current = readStamp(record, operation);

  if (
    operation.expected_updated_at !== undefined &&
    operation.expected_updated_at !== current
  ) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${draftTarget(operation)} was last updated at ${current}`
    );
  }

  const slug = stringSchema.safeParse(record.slug);

  return {
    editUrl: adminUrl(operation.collection, operation.id),
    editor: "Payload admin",
    fields: draftChangedPaths(operation).map((path) => {
      const before = record[path];
      const after = operation.fields[path];

      return {
        after: previewValue(after),
        before: previewValue(before),
        changed: !deepEqual(before, after),
        path,
      };
    }),
    modifiedGmt: current,
    operationIndex: index,
    sentence: draftSentence(operation),
    slug: slug.success ? slug.data : "",
    target: draftTarget(operation),
  };
};

const preflightFrom = async (
  client: WordPressClient,
  operations: DraftOperation[],
  adminUrl: PayloadAdminUrl,
  telemetry: WordPressTelemetry,
  index: number
): Promise<OperationPreflight[]> => {
  const operation = operations.at(index);

  if (operation === undefined) {
    return [];
  }

  const first = await preflightOne(
    client,
    operation,
    index,
    adminUrl,
    telemetry
  );

  return [
    first,
    ...(await preflightFrom(
      client,
      operations,
      adminUrl,
      telemetry,
      index + 1
    )),
  ];
};

export const preflightDraftOperations = async (
  client: WordPressClient,
  intent: string,
  operations: DraftOperation[],
  adminUrl: PayloadAdminUrl,
  telemetry: WordPressTelemetry
): Promise<ApplyPreflight> => {
  // One at a time, in order, as the WordPress preview does: each read is
  // bounded and a failure names the first document that could not be shown.
  const results = await preflightFrom(
    client,
    operations,
    adminUrl,
    telemetry,
    0
  );

  return { intent, operations: results };
};

const toReceiptError = <E>(error: E): ReceiptError => {
  if (error instanceof ApplyConflictError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof WordPressRequestError) {
    return { code: "payload_request_failed", message: error.message };
  }

  return { code: "unexpected_error", message: "The operation failed" };
};

const writeBody = (operation: DraftOperation): JsonObject => {
  const body: JsonObject = {};

  for (const path of draftChangedPaths(operation)) {
    const value = operation.fields[path];

    if (value !== undefined) {
      body[path] = value;
    }
  }

  return body;
};

const missedPathsMessage = (missed: string[]): string => {
  const listed = missed.slice(0, MISSED_PATH_LIMIT);
  const extra = missed.length - listed.length;

  return `Payload did not store ${listed.join(", ")}${extra > 0 ? ` and ${extra} more` : ""}`;
};

// The same reading as `wp.apply`'s readback: a stored value equal to the one
// asked for is a change, one still equal to the value before is a miss, and
// anything else is Payload rewriting what it stored (a hook, a sanitiser).
const classifyReadback = (
  operation: DraftOperation,
  before: JsonObject,
  after: JsonObject
) => {
  const changed: string[] = [];
  const missed: string[] = [];
  const normalized: string[] = [];

  for (const path of draftChangedPaths(operation)) {
    const requested = operation.fields[path];
    const previous = before[path];

    if (deepEqual(previous, requested)) {
      continue;
    }

    const stored = after[path];

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

const applyOne = async (
  client: WordPressClient,
  operation: DraftOperation,
  snapshot: OperationPreflight,
  telemetry: WordPressTelemetry
): Promise<OperationReceipt> => {
  const base: Pick<OperationReceipt, "kind" | "operation_index" | "target"> = {
    kind: "update_draft",
    operation_index: snapshot.operationIndex,
    target: snapshot.target,
  };

  const failure = (
    error: ReceiptError,
    status: OperationReceipt["status"] = "failed"
  ): OperationReceipt => ({
    ...base,
    changed_paths: [],
    error,
    normalized_paths: [],
    status,
  });

  if (snapshot.target !== draftTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  let before: JsonObject;

  try {
    before = await readDocument(client, operation, telemetry);
    assertDrafts(before, operation);
  } catch (error) {
    return failure(toReceiptError(error));
  }

  if (updatedAt(before) !== snapshot.modifiedGmt) {
    return failure(
      {
        code: "modified_since_preflight",
        message: `${snapshot.target} changed after the approval preview`,
      },
      "conflict"
    );
  }

  let write: WpFetchResult;

  try {
    write = await payloadRest(client, documentPath(operation), telemetry, {
      body: JSON.stringify(writeBody(operation)),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
  } catch (error) {
    return failure(toReceiptError(error));
  }

  if (write.status < 200 || write.status >= 300) {
    return failure({
      code: "write_failed",
      message: payloadErrorMessage(write),
    });
  }

  let after: JsonObject;

  try {
    after = await readDocument(client, operation, telemetry);
  } catch (error) {
    return failure(toReceiptError(error));
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

interface DraftApplyOptions {
  approverOpaque: string;
  client: WordPressClient;
  executionId: string;
  operations: DraftOperation[];
  preflight: ApplyPreflight;
  requesterOpaque: string;
  telemetry: WordPressTelemetry;
}

const applyFrom = async (
  options: DraftApplyOptions,
  index: number
): Promise<OperationReceipt[]> => {
  const operation = options.operations.at(index);

  if (operation === undefined) {
    return [];
  }

  const snapshot = options.preflight.operations.at(index);

  const receipt: OperationReceipt = snapshot
    ? await applyOne(options.client, operation, snapshot, options.telemetry)
    : {
        changed_paths: [],
        error: {
          code: "missing_preflight",
          message: "No approval preview exists for this operation",
        },
        kind: "update_draft",
        normalized_paths: [],
        operation_index: index,
        status: "failed",
        target: draftTarget(operation),
      };

  return [receipt, ...(await applyFrom(options, index + 1))];
};

export const applyDraftOperations = async (
  options: DraftApplyOptions
): Promise<BatchReceipt> => {
  // Writes go one after another, so a receipt names exactly what landed.
  const receipts = await applyFrom(options, 0);

  return {
    approverOpaque: options.approverOpaque,
    executionId: options.executionId,
    operations: receipts,
    requesterOpaque: options.requesterOpaque,
    status: batchStatus(receipts),
  };
};
