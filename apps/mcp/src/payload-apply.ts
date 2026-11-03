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
  FieldSnapshot,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
} from "./apply";
import {
  payloadErrorMessage,
  payloadMcpRequest,
  payloadRest,
  toPayloadToolResult,
} from "./payload";
import type { PayloadToolResult } from "./payload";
import {
  draftChangedPaths,
  draftFields,
  draftMarkdown,
  draftSentence,
  draftTarget,
} from "./payload-operations";
import type {
  DraftOperation,
  UpdateDraftOperation,
} from "./payload-operations";
import { WordPressRequestError } from "./wordpress";
import type {
  JsonObject,
  JsonValue,
  WordPressClient,
  WordPressTelemetry,
  WpFetchResult,
} from "./wordpress";

const MISSED_PATH_LIMIT = 5;

// The read-only tools apps/payload adds to Payload's MCP server
// (apps/payload/src/mcp-tools.ts).
export const EDITING_INFO_TOOL = "getEditingInfo";
export const MARKDOWN_TO_RICH_TEXT_TOOL = "markdownToRichText";
export const RICH_TEXT_TO_MARKDOWN_TOOL = "richTextToMarkdown";

const recordSchema = z.record(z.string(), z.json());
const stringSchema = z.string();
const documentIdSchema = z.union([z.number(), z.string()]);
const createdSchema = z.object({ doc: z.object({ id: documentIdSchema }) });
const markdownResultSchema = z.object({ markdown: z.string() });
const richTextResultSchema = z.object({ value: recordSchema });

const collectionEditingSchema = z.object({
  canCreate: z.boolean(),
  canUpdate: z.boolean(),
  drafts: z.boolean(),
  richTextFields: z.array(z.string()),
  slug: z.string(),
});

const editingInfoSchema = z.object({
  collections: z.array(collectionEditingSchema),
});

export type CollectionEditing = z.infer<typeof collectionEditingSchema>;

export type PayloadAdminUrl = (
  collection: string,
  id: number | string
) => string;

const documentPath = (collection: string, id: number | string): string =>
  `/api/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}?draft=true&depth=0`;

// Every read and write names the draft: a read returns the newest version,
// draft or published, and a write saves a new draft version and leaves the
// published one as it is.
const operationPath = (operation: UpdateDraftOperation): string =>
  documentPath(operation.collection, operation.id);

const createPath = (collection: string): string =>
  `/api/${encodeURIComponent(collection)}?draft=true&depth=0`;

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
  collection: string,
  id: number | string,
  telemetry: WordPressTelemetry
): Promise<JsonObject> => {
  const result = await payloadRest(
    client,
    documentPath(collection, id),
    telemetry
  );

  const parsed = recordSchema.safeParse(result.json);

  if (result.status < 200 || result.status >= 300 || !parsed.success) {
    throw failed(result, `${collection}/${id} was not found`);
  }

  return parsed.data;
};

// One call to a Payload MCP tool whose failure stops the operation: an
// unknown field, a conversion Payload refused, a tool the editor lacks.
const callTool = async (
  client: WordPressClient,
  name: string,
  args: JsonObject,
  telemetry: WordPressTelemetry
): Promise<PayloadToolResult> => {
  const result = toPayloadToolResult(
    await payloadMcpRequest(
      client,
      "tools/call",
      { arguments: args, name },
      telemetry
    )
  );

  if (result.isError) {
    throw new ApplyConflictError(
      "payload_tool_failed",
      `Payload ${name}: ${result.text.slice(0, 200)}`
    );
  }

  return result;
};

// Which collections keep drafts and take Markdown, as this editor sees them.
export const readEditingInfo = async (
  client: WordPressClient,
  telemetry: WordPressTelemetry
): Promise<CollectionEditing[]> => {
  const result = await callTool(client, EDITING_INFO_TOOL, {}, telemetry);
  const parsed = editingInfoSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new WordPressRequestError("Payload returned invalid editing info");
  }

  return parsed.data.collections;
};

// Only a collection with drafts keeps the published version apart from the
// one being written. Without drafts, `?draft=true` is ignored and the write
// would go live, so such a collection is refused before anything is shown.
const assertEditable = (
  info: CollectionEditing[],
  operation: DraftOperation
): void => {
  const collection = info.find((entry) => entry.slug === operation.collection);

  if (!collection) {
    throw new ApplyConflictError(
      "unknown_collection",
      `${operation.collection} is not a collection this editor can read`
    );
  }

  if (!collection.drafts) {
    throw new ApplyConflictError(
      "drafts_not_enabled",
      `${operation.collection} has no drafts, so a change there would publish at once`
    );
  }

  const allowed =
    operation.kind === "create_draft"
      ? collection.canCreate
      : collection.canUpdate;

  if (!allowed) {
    throw new ApplyConflictError(
      "not_permitted",
      `This editor may not ${operation.kind === "create_draft" ? "create" : "update"} ${operation.collection}`
    );
  }

  const notRichText = Object.keys(draftMarkdown(operation)).filter(
    (field) => !collection.richTextFields.includes(field)
  );

  if (notRichText.length > 0) {
    throw new ApplyConflictError(
      "not_rich_text",
      `${notRichText.join(", ")} in ${operation.collection} does not take Markdown`
    );
  }
};

// The same check on the document itself: a draft-enabled collection always
// stores `_status`, so a document without one is refused too.
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

const toRichText = async (
  client: WordPressClient,
  collection: string,
  field: string,
  markdown: string,
  telemetry: WordPressTelemetry
): Promise<JsonObject> => {
  const result = await callTool(
    client,
    MARKDOWN_TO_RICH_TEXT_TOOL,
    { field, markdown, slug: collection },
    telemetry
  );

  const parsed = richTextResultSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new WordPressRequestError(
      `Payload returned no rich text for ${field}`
    );
  }

  return parsed.data.value;
};

const toMarkdown = async (
  client: WordPressClient,
  collection: string,
  field: string,
  value: JsonValue | undefined,
  telemetry: WordPressTelemetry
): Promise<string> => {
  const stored = recordSchema.safeParse(value);

  if (!stored.success) {
    return "";
  }

  const result = await callTool(
    client,
    RICH_TEXT_TO_MARKDOWN_TOOL,
    { field, slug: collection, value: stored.data },
    telemetry
  );

  const parsed = markdownResultSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new WordPressRequestError(
      `Payload returned no Markdown for ${field}`
    );
  }

  return parsed.data.markdown;
};

// What Payload is sent: the stored values as given, and each Markdown field
// converted with that field's own editor features.
const resolveBody = async (
  client: WordPressClient,
  operation: DraftOperation,
  telemetry: WordPressTelemetry
): Promise<JsonObject> => {
  const fields = draftFields(operation);
  const markdown = Object.entries(draftMarkdown(operation));

  const converted = await Promise.all(
    markdown.map(
      async ([field, text]) =>
        [
          field,
          await toRichText(
            client,
            operation.collection,
            field,
            text,
            telemetry
          ),
        ] as const
    )
  );

  const body: JsonObject = {};

  for (const path of draftChangedPaths(operation)) {
    const value = fields[path];

    if (value !== undefined) {
      body[path] = value;
    }
  }

  for (const [field, value] of converted) {
    body[field] = value;
  }

  return body;
};

interface PreflightContext {
  adminUrl: PayloadAdminUrl;
  client: WordPressClient;
  info: CollectionEditing[];
  telemetry: WordPressTelemetry;
}

// A Markdown field is previewed as Markdown on both sides, so the approver
// reads the text, not Lexical JSON.
const snapshotField = async (
  context: PreflightContext,
  operation: DraftOperation,
  record: JsonObject,
  path: string
): Promise<FieldSnapshot> => {
  const markdown = draftMarkdown(operation)[path];

  if (markdown === undefined) {
    const before = record[path];
    const after = draftFields(operation)[path];

    return {
      after: previewValue(after),
      before: previewValue(before),
      changed: !deepEqual(before, after),
      path,
    };
  }

  const before = await toMarkdown(
    context.client,
    operation.collection,
    path,
    record[path],
    context.telemetry
  );

  return {
    after: previewValue(markdown),
    before: previewValue(before),
    changed: before.trim() !== markdown.trim(),
    path,
  };
};

const currentRecord = async (
  context: PreflightContext,
  operation: DraftOperation
): Promise<{ record: JsonObject; stamp: string }> => {
  if (operation.kind === "create_draft") {
    return { record: {}, stamp: "" };
  }

  const record = await readDocument(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  assertDrafts(record, operation);
  const stamp = readStamp(record, operation);

  if (
    operation.expected_updated_at !== undefined &&
    operation.expected_updated_at !== stamp
  ) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${draftTarget(operation)} was last updated at ${stamp}`
    );
  }

  return { record, stamp };
};

const previewSlug = (operation: DraftOperation, record: JsonObject): string => {
  const slug = stringSchema.safeParse(
    record.slug ?? draftFields(operation).slug
  );

  return slug.success ? slug.data : "";
};

const preflightOne = async (
  context: PreflightContext,
  operation: DraftOperation,
  index: number
): Promise<OperationPreflight> => {
  assertEditable(context.info, operation);
  const { record, stamp } = await currentRecord(context, operation);

  // Converting now proves Payload accepts the Markdown before anyone is asked
  // to approve it; apply converts it again from the same text.
  await resolveBody(context.client, operation, context.telemetry);

  const fields = await Promise.all(
    draftChangedPaths(operation).map((path) =>
      snapshotField(context, operation, record, path)
    )
  );

  return {
    editUrl:
      operation.kind === "create_draft"
        ? ""
        : context.adminUrl(operation.collection, operation.id),
    editor: "Payload admin",
    fields,
    modifiedGmt: stamp,
    operationIndex: index,
    sentence: draftSentence(operation),
    slug: previewSlug(operation, record),
    target: draftTarget(operation),
  };
};

const preflightFrom = async (
  context: PreflightContext,
  operations: DraftOperation[],
  index: number
): Promise<OperationPreflight[]> => {
  const operation = operations.at(index);

  if (operation === undefined) {
    return [];
  }

  const first = await preflightOne(context, operation, index);

  return [first, ...(await preflightFrom(context, operations, index + 1))];
};

export const preflightDraftOperations = async (
  client: WordPressClient,
  intent: string,
  operations: DraftOperation[],
  adminUrl: PayloadAdminUrl,
  telemetry: WordPressTelemetry
): Promise<ApplyPreflight> => {
  const info = await readEditingInfo(client, telemetry);

  // One at a time, in order, as the WordPress preview does: each read is
  // bounded and a failure names the first document that could not be shown.
  const results = await preflightFrom(
    { adminUrl, client, info, telemetry },
    operations,
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

const missedPathsMessage = (missed: string[]): string => {
  const listed = missed.slice(0, MISSED_PATH_LIMIT);
  const extra = missed.length - listed.length;

  return `Payload did not store ${listed.join(", ")}${extra > 0 ? ` and ${extra} more` : ""}`;
};

// The same reading as `wp.apply`'s readback: a stored value equal to the one
// asked for is a change, one still equal to the value before is a miss, and
// anything else is Payload rewriting what it stored (a hook, a sanitiser, or
// Lexical filling in node defaults).
const classifyReadback = (
  body: JsonObject,
  before: JsonObject,
  after: JsonObject
) => {
  const changed: string[] = [];
  const missed: string[] = [];
  const normalized: string[] = [];

  for (const path of Object.keys(body).toSorted()) {
    const requested = body[path];
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

// Markdown is compared as Markdown: Lexical from a fresh conversion seldom
// matches the stored JSON byte for byte, so a field the preview showed as
// unchanged is left out rather than rewritten. The preview's reading still
// holds at write time, because the write is refused if `updatedAt` moved.
const withoutUnchangedMarkdown = (
  body: JsonObject,
  operation: DraftOperation,
  snapshot: OperationPreflight
): JsonObject => {
  const unchanged = new Set(
    snapshot.fields.filter((field) => !field.changed).map((field) => field.path)
  );

  const result: JsonObject = {};

  for (const [path, value] of Object.entries(body)) {
    if (!(path in draftMarkdown(operation) && unchanged.has(path))) {
      result[path] = value;
    }
  }

  return result;
};

interface WriteResult {
  after: JsonObject;
  before: JsonObject;
  target: string;
}

const writeUpdate = async (
  client: WordPressClient,
  operation: UpdateDraftOperation,
  snapshot: OperationPreflight,
  body: JsonObject,
  telemetry: WordPressTelemetry
): Promise<WriteResult> => {
  const before = await readDocument(
    client,
    operation.collection,
    operation.id,
    telemetry
  );

  assertDrafts(before, operation);

  if (updatedAt(before) !== snapshot.modifiedGmt) {
    throw new ApplyConflictError(
      "modified_since_preflight",
      `${snapshot.target} changed after the approval preview`
    );
  }

  // Nothing left to send: no new draft version for a change that is none.
  if (Object.keys(body).length === 0) {
    return { after: before, before, target: snapshot.target };
  }

  const write = await payloadRest(client, operationPath(operation), telemetry, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  if (write.status < 200 || write.status >= 300) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  return {
    after: await readDocument(
      client,
      operation.collection,
      operation.id,
      telemetry
    ),
    before,
    target: snapshot.target,
  };
};

const writeCreate = async (
  client: WordPressClient,
  collection: string,
  body: JsonObject,
  telemetry: WordPressTelemetry
): Promise<WriteResult> => {
  const write = await payloadRest(client, createPath(collection), telemetry, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  const created = createdSchema.safeParse(write.json);

  if (write.status < 200 || write.status >= 300 || !created.success) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  const { id } = created.data.doc;

  return {
    after: await readDocument(client, collection, id, telemetry),
    before: {},
    target: `${collection}/${id}`,
  };
};

const applyOne = async (
  client: WordPressClient,
  operation: DraftOperation,
  snapshot: OperationPreflight,
  telemetry: WordPressTelemetry
): Promise<OperationReceipt> => {
  const failure = (
    error: ReceiptError,
    target = snapshot.target
  ): OperationReceipt => ({
    changed_paths: [],
    error,
    kind: operation.kind,
    normalized_paths: [],
    operation_index: snapshot.operationIndex,
    status: error.code === "modified_since_preflight" ? "conflict" : "failed",
    target,
  });

  if (snapshot.target !== draftTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  let written: WriteResult;

  try {
    // Checked again at write time: a collection's drafts or this editor's
    // permissions may have changed since the preview.
    assertEditable(await readEditingInfo(client, telemetry), operation);

    const body = withoutUnchangedMarkdown(
      await resolveBody(client, operation, telemetry),
      operation,
      snapshot
    );

    written =
      operation.kind === "create_draft"
        ? await writeCreate(client, operation.collection, body, telemetry)
        : await writeUpdate(client, operation, snapshot, body, telemetry);

    const readback = classifyReadback(body, written.before, written.after);

    if (readback.missed.length > 0) {
      return {
        changed_paths: readback.changed,
        error: {
          code: "readback_mismatch",
          message: missedPathsMessage(readback.missed),
        },
        kind: operation.kind,
        normalized_paths: readback.normalized,
        operation_index: snapshot.operationIndex,
        status: "failed",
        target: written.target,
      };
    }

    return {
      changed_paths: readback.changed,
      kind: operation.kind,
      normalized_paths: readback.normalized,
      operation_index: snapshot.operationIndex,
      status: readback.changed.length > 0 ? "changed" : "unchanged",
      target: written.target,
    };
  } catch (error) {
    return failure(toReceiptError(error));
  }
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
        kind: operation.kind,
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
