import {
  ApplyConflictError,
  UpstreamRequestError,
  batchStatus,
  deepEqual,
  previewValue,
} from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  BatchReceipt,
  FieldSnapshot,
  JsonObject,
  JsonValue,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  UpstreamClient,
  UpstreamFetchResult,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

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
  STATUS_FIELD,
} from "./payload-operations";
import type {
  DraftOperation,
  UpdateDraftOperation,
} from "./payload-operations";

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

const markdownResultSchema = z.object({
  lost: z.array(z.string()).default([]),
  markdown: z.string(),
});

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

// Every read names the draft, so it returns the newest version, draft or
// published. A write names it too, saving a new draft version and leaving
// the published one as it is, unless the operation publishes: then the write
// goes without `draft=true` and sets `_status` to published.
const draftQuery = (draft: boolean): string =>
  draft ? "?draft=true&depth=0" : "?depth=0";

const documentPath = (
  collection: string,
  id: number | string,
  draft = true
): string =>
  `/api/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}${draftQuery(draft)}`;

const operationPath = (operation: UpdateDraftOperation): string =>
  documentPath(operation.collection, operation.id, !operation.publish);

const createPath = (operation: DraftOperation): string =>
  `/api/${encodeURIComponent(operation.collection)}${draftQuery(!operation.publish)}`;

const updatedAt = (record: JsonObject): string | undefined => {
  const value = stringSchema.safeParse(record.updatedAt);

  return value.success ? value.data : undefined;
};

const failed = (
  result: UpstreamFetchResult,
  fallback: string
): ApplyConflictError =>
  new ApplyConflictError(
    result.status === 404 ? "not_found" : "read_failed",
    result.status === 404 ? fallback : payloadErrorMessage(result)
  );

const readDocument = async (
  client: UpstreamClient,
  collection: string,
  id: number | string,
  telemetry: UpstreamTelemetry
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
  client: UpstreamClient,
  name: string,
  args: JsonObject,
  telemetry: UpstreamTelemetry
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
  client: UpstreamClient,
  telemetry: UpstreamTelemetry
): Promise<CollectionEditing[]> => {
  const result = await callTool(client, EDITING_INFO_TOOL, {}, telemetry);
  const parsed = editingInfoSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new UpstreamRequestError("Payload returned invalid editing info");
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
  client: UpstreamClient,
  collection: string,
  field: string,
  markdown: string,
  telemetry: UpstreamTelemetry
): Promise<JsonObject> => {
  const result = await callTool(
    client,
    MARKDOWN_TO_RICH_TEXT_TOOL,
    { field, markdown, slug: collection },
    telemetry
  );

  const parsed = richTextResultSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new UpstreamRequestError(
      `Payload returned no rich text for ${field}`
    );
  }

  return parsed.data.value;
};

const toMarkdown = async (
  client: UpstreamClient,
  collection: string,
  field: string,
  value: JsonValue | undefined,
  telemetry: UpstreamTelemetry
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
    throw new UpstreamRequestError(`Payload returned no Markdown for ${field}`);
  }

  // Writing Markdown back would turn these nodes into plain text, deleting
  // them while the Markdown preview hides what they held.
  if (parsed.data.lost.length > 0) {
    throw new ApplyConflictError(
      "markdown_would_lose_content",
      `${collection} ${field} holds ${parsed.data.lost.join(", ")} nodes that Markdown cannot carry; change it in fields as Lexical JSON, or in the Payload admin`
    );
  }

  return parsed.data.markdown;
};

// What Payload is sent: the stored values as given, and each Markdown field
// converted with that field's own editor features.
const resolveBody = async (
  client: UpstreamClient,
  operation: DraftOperation,
  telemetry: UpstreamTelemetry
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

  if (operation.publish) {
    body[STATUS_FIELD] = "published";
  }

  return body;
};

interface PreflightContext {
  adminUrl: PayloadAdminUrl;
  client: UpstreamClient;
  info: CollectionEditing[];
  telemetry: UpstreamTelemetry;
}

// A Markdown field is previewed as Markdown on both sides, so the approver
// reads the text, not Lexical JSON.
const snapshotField = async (
  context: PreflightContext,
  operation: DraftOperation,
  record: JsonObject,
  path: string
): Promise<FieldSnapshot> => {
  if (path === STATUS_FIELD) {
    const before = record[STATUS_FIELD];

    return {
      after: "published",
      before: previewValue(before),
      changed: before !== "published",
      path,
    };
  }

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
    // Only trailing whitespace is ignored: leading spaces change how
    // Markdown parses (an indented line is a code block).
    changed: before.trimEnd() !== markdown.trimEnd(),
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
  client: UpstreamClient,
  intent: string,
  operations: DraftOperation[],
  adminUrl: PayloadAdminUrl,
  telemetry: UpstreamTelemetry
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

  if (error instanceof UpstreamRequestError) {
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

class CreatedReadbackError extends Error {
  readonly receipt: ReceiptError;
  readonly target: string;

  constructor(target: string, receipt: ReceiptError) {
    super(receipt.message);
    this.name = "CreatedReadbackError";
    this.receipt = receipt;
    this.target = target;
  }
}

interface WriteResult {
  after: JsonObject;
  before: JsonObject;
  target: string;
}

const writeUpdate = async (
  client: UpstreamClient,
  operation: UpdateDraftOperation,
  snapshot: OperationPreflight,
  body: JsonObject,
  telemetry: UpstreamTelemetry
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
  client: UpstreamClient,
  operation: DraftOperation,
  body: JsonObject,
  telemetry: UpstreamTelemetry
): Promise<WriteResult> => {
  const { collection } = operation;

  const write = await payloadRest(client, createPath(operation), telemetry, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  const created = createdSchema.safeParse(write.json);

  if (write.status < 200 || write.status >= 300 || !created.success) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  const { id } = created.data.doc;
  const target = `${collection}/${id}`;

  try {
    return {
      after: await readDocument(client, collection, id, telemetry),
      before: {},
      target,
    };
  } catch (error) {
    // The document exists now: the receipt must name it, so nobody creates
    // it a second time thinking the first attempt failed.
    throw new CreatedReadbackError(target, toReceiptError(error));
  }
};

const applyOne = async (
  client: UpstreamClient,
  operation: DraftOperation,
  snapshot: OperationPreflight,
  telemetry: UpstreamTelemetry
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
        ? await writeCreate(client, operation, body, telemetry)
        : await writeUpdate(client, operation, snapshot, body, telemetry);

    const readback = classifyReadback(body, written.before, written.after);

    // A hook or field access can keep `_status` a draft, which readback
    // would count as normalised. A requested publish must have landed.
    if (operation.publish && written.after[STATUS_FIELD] !== "published") {
      return {
        changed_paths: readback.changed.filter((path) => path !== STATUS_FIELD),
        error: {
          code: "not_published",
          message: `Payload saved ${written.target} but did not publish it`,
        },
        kind: operation.kind,
        normalized_paths: readback.normalized,
        operation_index: snapshot.operationIndex,
        status: "failed",
        target: written.target,
      };
    }

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
    if (error instanceof CreatedReadbackError) {
      return failure(
        {
          code: "created_readback_failed",
          message: `${error.target} was created, but reading it back failed: ${error.receipt.message}`,
        },
        error.target
      );
    }

    return failure(toReceiptError(error));
  }
};

interface DraftApplyOptions {
  approverOpaque: string;
  client: UpstreamClient;
  executionId: string;
  // Hears each receipt as its operation settles, so a run that stops part
  // way still has a record of what landed (a created draft above all). A
  // failure to record progress never fails the write it describes.
  onProgress?: (receipt: OperationReceipt) => Promise<void>;
  operations: DraftOperation[];
  preflight: ApplyPreflight;
  requesterOpaque: string;
  telemetry: UpstreamTelemetry;
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

  try {
    await options.onProgress?.(receipt);
  } catch {
    // Progress is a view of the write, not part of it.
  }

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
