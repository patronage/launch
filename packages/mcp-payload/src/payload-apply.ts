import {
  ApplyConflictError,
  UpstreamRequestError,
  batchStatus,
  previewValue,
  receiptDetails,
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
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadErrorMessage, payloadRest } from "./payload";
import {
  classifyReadback,
  CONFLICT_CODES,
  documentPath,
  draftQuery,
  LOCKED_STATUS,
  lockedError,
  missedPathsMessage,
  readDocument,
  toReceiptError,
  updatedAt,
  writtenStamp,
  writtenVersionId,
} from "./payload-documents";
import type { PayloadAdminUrl, PayloadSiteUrl } from "./payload-documents";
import {
  callPayloadTool,
  MARKDOWN_TO_RICH_TEXT_TOOL,
  readEditingInfo,
  readPreviewUrl,
  RICH_TEXT_TO_MARKDOWN_TOOL,
} from "./payload-editing";
import type { CollectionEditing, EditingInfo } from "./payload-editing";
import {
  draftChangedPaths,
  draftFields,
  draftMarkdown,
  draftSentence,
  draftTarget,
  isUploadOperation,
  operationTarget,
  STATUS_FIELD,
} from "./payload-operations";
import type {
  DraftOperation,
  PayloadOperation,
  UpdateDraftOperation,
} from "./payload-operations";
import { createTitleLookup, fieldSnapshot } from "./payload-relations";
import type { TitleLookup } from "./payload-relations";
import { applyUpload, preflightUpload } from "./payload-upload-apply";
import type { UploadFiles } from "./payload-upload-apply";

const recordSchema = z.record(z.string(), z.json());
const stringSchema = z.string();
const documentIdSchema = z.union([z.number(), z.string()]);
const createdSchema = z.object({ doc: z.object({ id: documentIdSchema }) });

const markdownResultSchema = z.object({
  lost: z.array(z.string()).default([]),
  markdown: z.string(),
});

const richTextResultSchema = z.object({ value: recordSchema });

const operationPath = (operation: UpdateDraftOperation): string =>
  documentPath(operation.collection, operation.id, !operation.publish);

const createPath = (operation: DraftOperation): string =>
  `/api/${encodeURIComponent(operation.collection)}${draftQuery(!operation.publish)}`;

// Only a collection with drafts keeps the published version apart from the
// one being written. Without drafts, `?draft=true` is ignored and the write
// would go live, so such a collection is refused before anything is shown.
const assertEditable = (
  info: EditingInfo,
  operation: DraftOperation
): CollectionEditing => {
  const collection = info.collections.find(
    (entry) => entry.slug === operation.collection
  );

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

  return collection;
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
  const result = await callPayloadTool(
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

  const result = await callPayloadTool(
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
  // Where a staged file is read from. Without it, an upload has no file.
  files?: UploadFiles | undefined;
  info: EditingInfo;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
  titles: TitleLookup;
}

// A Markdown field is previewed as Markdown on both sides, so the approver
// reads the text, not Lexical JSON.
const snapshotField = async (
  context: PreflightContext,
  operation: DraftOperation,
  collection: CollectionEditing,
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
    return await fieldSnapshot(
      context.titles,
      collection.relationFields,
      path,
      {
        after: draftFields(operation)[path],
        before: record[path],
      }
    );
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

// The front end's draft preview of the document as it is now, where its
// collection has one. A new document has no address until it is saved.
const previewLink = async (
  context: Pick<PreflightContext, "client" | "siteUrl" | "telemetry">,
  collection: CollectionEditing,
  id: number | string
): Promise<string> => {
  if (!collection.preview) {
    return "";
  }

  const link = await readPreviewUrl(
    context.client,
    collection.slug,
    id,
    context.telemetry
  );

  return link === undefined ? "" : context.siteUrl(link);
};

const preflightOne = async (
  context: PreflightContext,
  operation: DraftOperation,
  index: number
): Promise<OperationPreflight> => {
  const collection = assertEditable(context.info, operation);
  const { record, stamp } = await currentRecord(context, operation);

  // Converting now proves Payload accepts the Markdown before anyone is asked
  // to approve it; apply converts it again from the same text.
  await resolveBody(context.client, operation, context.telemetry);

  const fields = await Promise.all(
    draftChangedPaths(operation).map((path) =>
      snapshotField(context, operation, collection, record, path)
    )
  );

  const previewUrl =
    operation.kind === "create_draft"
      ? ""
      : await previewLink(context, collection, operation.id);

  const preview: OperationPreflight = {
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

  if (previewUrl) {
    preview.previewUrl = previewUrl;
  }

  return preview;
};

const preflightFrom = async (
  context: PreflightContext,
  operations: PayloadOperation[],
  index: number
): Promise<OperationPreflight[]> => {
  const operation = operations.at(index);

  if (operation === undefined) {
    return [];
  }

  const first = isUploadOperation(operation)
    ? await preflightUpload(context, operation, index)
    : await preflightOne(context, operation, index);

  return [first, ...(await preflightFrom(context, operations, index + 1))];
};

const noSiteUrl: PayloadSiteUrl = () => "";

export interface DraftPreflightOptions {
  // The run's staged files, for an upload's preview.
  files?: UploadFiles | undefined;
  // Makes the draft preview link a preview offers. Without it, none is.
  siteUrl?: PayloadSiteUrl | undefined;
}

export const preflightDraftOperations = async (
  client: UpstreamClient,
  intent: string,
  operations: PayloadOperation[],
  adminUrl: PayloadAdminUrl,
  telemetry: UpstreamTelemetry,
  options: DraftPreflightOptions = {}
): Promise<ApplyPreflight> => {
  const info = await readEditingInfo(client, telemetry);

  // One at a time, in order, as the WordPress preview does: each read is
  // bounded and a failure names the first document that could not be shown.
  const results = await preflightFrom(
    {
      adminUrl,
      client,
      files: options.files,
      info,
      siteUrl: options.siteUrl ?? noSiteUrl,
      telemetry,
      titles: createTitleLookup(client, info, telemetry),
    },
    operations,
    0
  );

  return { intent, operations: results };
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
  // Set when the write made the document, so its receipt can name the id.
  created?: true;
  id: number | string;
  // False when nothing was sent, because nothing the operation named differs.
  sent: boolean;
  // The document's `updatedAt` in the write's own response, which ties the
  // version the write made to it. Absent when nothing was sent.
  stamp?: string | undefined;
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
    return {
      after: before,
      before,
      id: operation.id,
      sent: false,
      target: snapshot.target,
    };
  }

  const write = await payloadRest(client, operationPath(operation), telemetry, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  if (write.status === LOCKED_STATUS) {
    throw lockedError(snapshot.target);
  }

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
    id: operation.id,
    sent: true,
    stamp: writtenStamp(write),
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
      created: true,
      id,
      sent: true,
      stamp: writtenStamp(write),
      target,
    };
  } catch (error) {
    // The document exists now: the receipt must name it, so nobody creates
    // it a second time thinking the first attempt failed.
    throw new CreatedReadbackError(target, toReceiptError(error));
  }
};

interface ApplyContext {
  client: UpstreamClient;
  files?: UploadFiles | undefined;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

type LandedFacts = Pick<
  OperationReceipt,
  "details" | "updated_at" | "version_id"
>;

// What a caller needs after a write to carry on from it: when the document
// was last updated, for the next write's `expected_updated_at`; the version
// the write made; a new document's id; and the link to preview the draft.
const landedFacts = async (
  context: ApplyContext,
  collection: CollectionEditing,
  written: WriteResult
): Promise<LandedFacts> => {
  const facts: LandedFacts = {};
  const stamp = updatedAt(written.after);

  if (stamp !== undefined) {
    facts.updated_at = stamp;
  }

  if (!written.sent) {
    return facts;
  }

  const [versionId, preview] = await Promise.all([
    writtenVersionId(
      context.client,
      collection.slug,
      written,
      context.telemetry
    ),
    previewLink(context, collection, written.id),
  ]);

  if (versionId !== undefined) {
    facts.version_id = versionId;
  }

  const details = receiptDetails({
    id: written.created ? written.id : undefined,
    preview_url: preview,
  });

  if (details) {
    facts.details = details;
  }

  return facts;
};

const applyOne = async (
  context: ApplyContext,
  operation: DraftOperation,
  snapshot: OperationPreflight
): Promise<OperationReceipt> => {
  const { client, telemetry } = context;

  const failure = (
    error: ReceiptError,
    target = snapshot.target
  ): OperationReceipt => ({
    changed_paths: [],
    error,
    kind: operation.kind,
    normalized_paths: [],
    operation_index: snapshot.operationIndex,
    status: CONFLICT_CODES.has(error.code) ? "conflict" : "failed",
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
    const collection = assertEditable(
      await readEditingInfo(client, telemetry),
      operation
    );

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
    const landed = await landedFacts(context, collection, written);

    // A hook or field access can keep `_status` a draft, which readback
    // would count as normalised. A requested publish must have landed.
    if (operation.publish && written.after[STATUS_FIELD] !== "published") {
      return {
        ...landed,
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
        ...landed,
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
      ...landed,
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

const applyAs = (
  context: ApplyContext,
  operation: PayloadOperation,
  snapshot: OperationPreflight
): Promise<OperationReceipt> =>
  isUploadOperation(operation)
    ? applyUpload(context, operation, snapshot)
    : applyOne(context, operation, snapshot);

interface DraftApplyOptions {
  approverOpaque: string;
  client: UpstreamClient;
  executionId: string;
  // Where this run's staged files are read from, and what measures them.
  // Without it, an upload reports that its file was never staged.
  files?: Omit<UploadFiles, "executionId"> | undefined;
  // Hears each receipt as its operation settles, so a run that stops part
  // way still has a record of what landed (a created draft above all). A
  // failure to record progress never fails the write it describes.
  onProgress?: (receipt: OperationReceipt) => Promise<void>;
  operations: PayloadOperation[];
  preflight: ApplyPreflight;
  requesterOpaque: string;
  // Makes the draft preview link a receipt offers. Without it, none is.
  siteUrl?: PayloadSiteUrl;
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

  const context: ApplyContext = {
    client: options.client,
    files: options.files && {
      ...options.files,
      executionId: options.executionId,
    },
    siteUrl: options.siteUrl ?? noSiteUrl,
    telemetry: options.telemetry,
  };

  const receipt: OperationReceipt = snapshot
    ? await applyAs(context, operation, snapshot)
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
        target: operationTarget(operation),
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
