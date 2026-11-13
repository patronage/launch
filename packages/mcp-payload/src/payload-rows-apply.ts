import {
  ApplyConflictError,
  previewValue,
  receiptDetails,
} from "@patronage/mcp-core";
import type {
  FieldSnapshot,
  JsonObject,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";

import { payloadErrorMessage, payloadRest } from "./payload";
import {
  assertDraftDocument,
  CONFLICT_CODES,
  documentPath,
  draftCollection,
  LOCKED_STATUS,
  lockedError,
  missedPathsMessage,
  previewLink,
  readDocument,
  requireStamp,
  toReceiptError,
  updatedAt,
  writtenStamp,
  writtenVersionId,
} from "./payload-documents";
import type { PayloadAdminUrl, PayloadSiteUrl } from "./payload-documents";
import { readEditingInfo } from "./payload-editing";
import type { CollectionEditing, EditingInfo } from "./payload-editing";
import { rowsSentence, rowsTarget, STATUS_FIELD } from "./payload-operations";
import type { PatchRowsOperation } from "./payload-operations";
import { toMarkdown, toRichText } from "./payload-rich-text";
import { patchRows, readBackRows } from "./payload-rows";
import type { RowContext, RowConverters, RowsPatch } from "./payload-rows";

// `patch_rows`: changes to single rows of a document's array and blocks
// fields. Payload saves such a field whole, so the gateway reads the draft,
// makes the changes on a copy (payload-rows.ts), shows each one to the
// approver, and after approval sends only the top-level fields that hold
// the changed rows, as a new draft of the document.

export interface RowsContext {
  client: UpstreamClient;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

export interface RowsPreflightContext extends RowsContext {
  adminUrl: PayloadAdminUrl;
  info: EditingInfo;
}

const rowsCollection = (
  info: EditingInfo,
  operation: PatchRowsOperation
): CollectionEditing => {
  const collection = draftCollection(info, operation.collection);

  if (!collection.canUpdate) {
    throw new ApplyConflictError(
      "not_permitted",
      `This editor may not update ${operation.collection}`
    );
  }

  return collection;
};

// A row path always goes through a row, so the document's own rich text
// fields never come into it.
const documentContext = (collection: CollectionEditing): RowContext => ({
  richTextFields: [],
  rowFields: collection.rowFields,
});

// Payload converts with the nested field's own editor features, found by
// the field names and block slugs on the way down to it.
const converters = (
  context: RowsContext,
  collection: string
): RowConverters => ({
  toMarkdown: (schemaPath, value) =>
    toMarkdown(
      context.client,
      { collection, field: schemaPath.at(-1) ?? "", path: schemaPath },
      value,
      context.telemetry
    ),
  toRichText: (schemaPath, markdown) =>
    toRichText(
      context.client,
      { collection, field: schemaPath.at(-1) ?? "", path: schemaPath },
      markdown,
      context.telemetry
    ),
});

const readDraft = async (
  context: RowsContext,
  operation: PatchRowsOperation
): Promise<JsonObject> => {
  const record = await readDocument(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  assertDraftDocument(record, operation.collection);

  return record;
};

const statusSnapshot = (record: JsonObject): FieldSnapshot => ({
  after: "published",
  before: previewValue(record[STATUS_FIELD]),
  changed: record[STATUS_FIELD] !== "published",
  path: STATUS_FIELD,
});

export const preflightRows = async (
  context: RowsPreflightContext,
  operation: PatchRowsOperation,
  index: number
): Promise<OperationPreflight> => {
  const collection = rowsCollection(context.info, operation);
  const record = await readDraft(context, operation);
  const stamp = requireStamp(record, rowsTarget(operation));

  if (operation.expected_updated_at !== stamp) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${rowsTarget(operation)} was last updated at ${stamp}`
    );
  }

  const patch = await patchRows(
    record,
    documentContext(collection),
    operation.changes,
    converters(context, operation.collection)
  );

  const previewUrl = await previewLink(context, collection, operation.id);
  const slug = record.slug === undefined ? "" : previewValue(record.slug);

  const preview: OperationPreflight = {
    editUrl: context.adminUrl(operation.collection, operation.id),
    editor: "Payload admin",
    fields: operation.publish
      ? [...patch.snapshots, statusSnapshot(record)]
      : patch.snapshots,
    modifiedGmt: stamp,
    operationIndex: index,
    sentence: rowsSentence(operation),
    slug,
    target: rowsTarget(operation),
  };

  if (previewUrl) {
    preview.previewUrl = previewUrl;
  }

  return preview;
};

interface Written {
  after: JsonObject;
  before: JsonObject;
  patch: RowsPatch;
  // False when no row differs and nothing was sent.
  sent: boolean;
  stamp?: string | undefined;
}

const writeRows = async (
  context: RowsContext,
  operation: PatchRowsOperation,
  snapshot: OperationPreflight,
  rows: RowContext
): Promise<Written> => {
  const before = await readDraft(context, operation);

  if (updatedAt(before) !== snapshot.modifiedGmt) {
    throw new ApplyConflictError(
      "modified_since_preflight",
      `${snapshot.target} changed after the approval preview`
    );
  }

  // Made again on the document as it is now, which is the one the approver
  // saw: its `updatedAt` has not moved.
  const patch = await patchRows(
    before,
    rows,
    operation.changes,
    converters(context, operation.collection)
  );

  const body: JsonObject = {};

  for (const field of patch.touched) {
    const value = patch.working[field];

    if (value !== undefined) {
      body[field] = value;
    }
  }

  if (operation.publish) {
    body[STATUS_FIELD] = "published";
  }

  if (Object.keys(body).length === 0) {
    return { after: before, before, patch, sent: false };
  }

  const write = await payloadRest(
    context.client,
    documentPath(operation.collection, operation.id, !operation.publish),
    context.telemetry,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }
  );

  if (write.status === LOCKED_STATUS) {
    throw lockedError(snapshot.target);
  }

  if (write.status < 200 || write.status >= 300) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  return {
    after: await readDocument(
      context.client,
      operation.collection,
      operation.id,
      context.telemetry
    ),
    before,
    patch,
    sent: true,
    stamp: writtenStamp(write),
  };
};

// The longest value a receipt detail holds before mcp-core cuts it short.
const DETAIL_LIMIT = 400;

// The ids that fit whole in one receipt detail. An id is never cut: a cut
// one would read as an id and name no row.
const wholeIds = (ids: string[]): string[] => {
  const listed: string[] = [];

  for (const id of ids) {
    if ([...listed, id].join(", ").length > DETAIL_LIMIT) {
      break;
    }

    listed.push(id);
  }

  return listed;
};

interface InsertedRows {
  // Only when not every id fits: how many rows were put in, so the caller
  // knows to read the document for the rest.
  inserted_row_count: number | undefined;
  inserted_row_ids: string;
}

// The ids Payload gave the new rows, in the order they were asked for, so
// a later change can name them. The operation's schema keeps the number of
// inserts to what fits with Payload's own ids; longer custom ids may not.
export const insertedRows = (inserted: string[]): InsertedRows => {
  const listed = wholeIds(inserted);

  return {
    inserted_row_count:
      listed.length < inserted.length ? inserted.length : undefined,
    inserted_row_ids: listed.join(", "),
  };
};

type LandedFacts = Pick<
  OperationReceipt,
  "details" | "updated_at" | "version_id"
>;

const landedFacts = async (
  context: RowsContext,
  operation: PatchRowsOperation,
  collection: CollectionEditing,
  written: Written,
  inserted: string[]
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
      operation.collection,
      { id: operation.id, stamp: written.stamp },
      context.telemetry
    ),
    previewLink(context, collection, operation.id),
  ]);

  if (versionId !== undefined) {
    facts.version_id = versionId;
  }

  const details = receiptDetails({
    ...insertedRows(inserted),
    preview_url: preview,
  });

  if (details) {
    facts.details = details;
  }

  return facts;
};

export const applyRows = async (
  context: RowsContext,
  operation: PatchRowsOperation,
  snapshot: OperationPreflight
): Promise<OperationReceipt> => {
  const outcome = (
    status: OperationReceipt["status"],
    paths: { changed: string[]; normalized: string[] },
    error?: ReceiptError
  ): OperationReceipt => {
    const receipt: OperationReceipt = {
      changed_paths: paths.changed,
      kind: operation.kind,
      normalized_paths: paths.normalized,
      operation_index: snapshot.operationIndex,
      status,
      target: snapshot.target,
    };

    if (error) {
      receipt.error = error;
    }

    return receipt;
  };

  const failure = (error: ReceiptError): OperationReceipt =>
    outcome(
      CONFLICT_CODES.has(error.code) ? "conflict" : "failed",
      { changed: [], normalized: [] },
      error
    );

  if (snapshot.target !== rowsTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    // Checked again at write time: the collection's drafts or this editor's
    // permissions may have changed since the preview.
    const collection = rowsCollection(
      await readEditingInfo(context.client, context.telemetry),
      operation
    );

    const rows = documentContext(collection);
    const written = await writeRows(context, operation, snapshot, rows);
    const readback = readBackRows(written.patch, written.after, rows);
    const published = written.after[STATUS_FIELD] === "published";

    const paths = {
      changed:
        operation.publish &&
        published &&
        written.before[STATUS_FIELD] !== "published"
          ? [...readback.changed, STATUS_FIELD]
          : readback.changed,
      normalized: readback.normalized,
    };

    const landed = await landedFacts(
      context,
      operation,
      collection,
      written,
      readback.inserted
    );

    // A hook or field access can keep `_status` a draft. A requested
    // publish must have landed.
    if (operation.publish && !published) {
      return {
        ...landed,
        ...outcome("failed", paths, {
          code: "not_published",
          message: `Payload saved ${snapshot.target} but did not publish it`,
        }),
      };
    }

    if (readback.missed.length > 0) {
      return {
        ...landed,
        ...outcome("failed", paths, {
          code: "readback_mismatch",
          message: missedPathsMessage(readback.missed),
        }),
      };
    }

    return {
      ...landed,
      ...outcome(paths.changed.length > 0 ? "changed" : "unchanged", paths),
    };
  } catch (error) {
    return failure(toReceiptError(error));
  }
};
