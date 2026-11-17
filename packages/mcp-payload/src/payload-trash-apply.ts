import { ApplyConflictError, receiptDetails } from "@patronage/mcp-core";
import type {
  FieldSnapshot,
  JsonObject,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadErrorMessage, payloadRest } from "./payload";
import {
  CONFLICT_CODES,
  documentPath,
  draftCollection,
  LOCKED_STATUS,
  lockedError,
  previewLink,
  readTrashable,
  requireStamp,
  toReceiptError,
  updatedAt,
  writtenStamp,
  writtenVersionId,
} from "./payload-documents";
import type { PayloadAdminUrl, PayloadSiteUrl } from "./payload-documents";
import { readDocumentAddress, readEditingInfo } from "./payload-editing";
import type { CollectionEditing, EditingInfo } from "./payload-editing";
import { STATUS_FIELD, trashSentence, trashTarget } from "./payload-operations";
import type { TrashOperation } from "./payload-operations";
import { findReferences, referencesPhrase } from "./payload-references";

// `trash` and `restore_from_trash`: what the admin's Delete button does in a
// collection that keeps a trash, and what its Restore button does. Both are
// an ordinary save of `deletedAt`, so Payload checks the editor's
// permissions and another editor's lock itself.
//
// Nothing here sends a DELETE. In Payload that removes the document and
// its versions for good, `?trash=true` included: there the flag only lets
// the delete reach a document that is already in the trash.

export interface TrashContext {
  client: UpstreamClient;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

export interface TrashPreflightContext extends TrashContext {
  adminUrl: PayloadAdminUrl;
  info: EditingInfo;
}

// The field Payload keeps the trash in: when the document went there, or
// null while it is not there.
export const TRASH_FIELD = "deletedAt";

const trashable = (
  info: EditingInfo,
  operation: TrashOperation
): CollectionEditing => {
  const collection = draftCollection(info, operation.collection);

  if (collection.upload) {
    throw new ApplyConflictError(
      "not_supported",
      `${operation.collection} holds files, which are not moved to or from the trash here`
    );
  }

  if (!collection.trash) {
    throw new ApplyConflictError(
      "trash_not_enabled",
      `${operation.collection} keeps no trash, so a document there could only be deleted for good`
    );
  }

  // Payload asks for both to trash a document, and for the first to take
  // it back out.
  const permitted =
    collection.canUpdate &&
    (operation.kind === "restore_from_trash" || collection.canDelete);

  if (!permitted) {
    throw new ApplyConflictError(
      "not_permitted",
      operation.kind === "trash"
        ? `This editor may not delete ${operation.collection}`
        : `This editor may not update ${operation.collection}`
    );
  }

  return collection;
};

const trashedAt = (record: JsonObject): string | undefined => {
  const at = z.string().min(1).safeParse(record[TRASH_FIELD]);

  return at.success ? at.data : undefined;
};

// The document as it stands, in the trash or out of it, refused when it is
// not where the operation needs it to be.
const readCurrent = async (
  context: TrashContext,
  operation: TrashOperation
): Promise<JsonObject> => {
  const target = trashTarget(operation);

  const record = await readTrashable(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  const inTrash = trashedAt(record) !== undefined;

  if (operation.kind === "trash" && inTrash) {
    throw new ApplyConflictError(
      "already_in_trash",
      `${target} is in the trash already`
    );
  }

  if (operation.kind === "restore_from_trash" && !inTrash) {
    throw new ApplyConflictError(
      "not_in_trash",
      `${target} is not in the trash, so there is nothing to restore`
    );
  }

  return record;
};

const statusSchema = z.object({ _status: z.string() });

// Whether the public sees the document: the status of the document itself,
// not of its newest version. Only asked of a document outside the trash.
const isPublic = async (
  context: TrashContext,
  operation: TrashOperation
): Promise<boolean> => {
  const result = await payloadRest(
    context.client,
    `${documentPath(operation.collection, operation.id, false)}&select[_status]=true`,
    context.telemetry
  );

  const parsed = statusSchema.safeParse(result.json);

  if (result.status !== 200 || !parsed.success) {
    throw new ApplyConflictError(
      "read_failed",
      `Payload did not say whether ${trashTarget(operation)} is published`
    );
  }

  return parsed.data._status === "published";
};

const TITLE_LIMIT = 80;

// "“Fall cleanup day”", or "" for a document without a title.
const quotedTitle = (
  record: JsonObject,
  collection: CollectionEditing
): string => {
  const title = z
    .string()
    .min(1)
    .safeParse(collection.titleField && record[collection.titleField]);

  return title.success ? `“${title.data.slice(0, TITLE_LIMIT)}”` : "";
};

const joined = (...parts: string[]): string =>
  parts.filter((part) => part.length > 0).join(", ");

// As much of a path as a warning shows, so the whole warning fits.
const PATH_LIMIT = 80;

interface Standing {
  // Whether the newest version is a draft saved since the document was
  // published.
  newerDraft: boolean;
  // The public path, where Payload gives one.
  path?: string | undefined;
  published: boolean;
}

// What the approver is told above a trash. Payload gives a trashed document
// the content and status of its newest version, so a published page with a
// newer draft comes back out as that draft.
const trashWarning = (standing: Standing): string => {
  const back = "It moves to the trash, where it can be restored as a draft.";

  if (!standing.published) {
    return back;
  }

  const { path } = standing;

  const page =
    path === undefined || path.length > PATH_LIMIT
      ? "The public page"
      : `The public page at ${path}`;

  const draft = standing.newerDraft
    ? " What comes back is its newest draft, not the page as published now."
    : "";

  return `${page} goes away as soon as you approve, and links to it will 404. ${back}${draft}`;
};

const RESTORE_AS_DRAFT_WARNING =
  "It comes back as a draft. Its public page stays away until it is published.";

const RESTORE_AND_PUBLISH_WARNING =
  "Its public page comes back as soon as you approve, holding what the document held when it went to the trash.";

// The row that names the document and where it is going.
const trashRow = (before: string, after: string): FieldSnapshot => ({
  after,
  before,
  changed: true,
  label: "Trash",
  path: TRASH_FIELD,
});

const slugOf = (record: JsonObject): string => {
  const slug = z.string().safeParse(record.slug);

  return slug.success ? slug.data : "";
};

const preflightTrash = async (
  context: TrashPreflightContext,
  operation: TrashOperation,
  seen: { collection: CollectionEditing; current: JsonObject }
): Promise<Pick<OperationPreflight, "fields" | "warning">> => {
  const { collection, current } = seen;

  const [published, address, references] = await Promise.all([
    isPublic(context, operation),
    collection.preview
      ? readDocumentAddress(
          context.client,
          operation.collection,
          operation.id,
          context.telemetry
        )
      : Promise.resolve({ path: undefined }),
    findReferences(context, context.info, operation),
  ]);

  const fields = [
    trashRow(
      joined(
        quotedTitle(current, collection),
        published ? "published" : "draft"
      ),
      "in the trash"
    ),
  ];

  const linked = referencesPhrase(references);

  if (linked) {
    fields.push({
      after: "still pointing at it, in the trash",
      before: linked,
      changed: true,
      label: "Linked from at least",
      path: "(links)",
    });
  }

  return {
    fields,
    warning: trashWarning({
      newerDraft: published && current[STATUS_FIELD] !== "published",
      path: address.path,
      published,
    }),
  };
};

const preflightRestore = (
  operation: TrashOperation,
  seen: { collection: CollectionEditing; current: JsonObject }
): Pick<OperationPreflight, "fields" | "warning"> => {
  const publishes =
    operation.kind === "restore_from_trash" && operation.publish === true;

  const fields = [
    trashRow(
      joined(
        quotedTitle(seen.current, seen.collection),
        `in the trash since ${trashedAt(seen.current) ?? ""}`
      ),
      "restored"
    ),
  ];

  // The status a trashed document carries is not one the public sees, so
  // the row says where it is instead.
  fields.push({
    after: publishes ? "published" : "draft",
    before: "in the trash",
    changed: true,
    path: STATUS_FIELD,
  });

  return {
    fields,
    warning: publishes ? RESTORE_AND_PUBLISH_WARNING : RESTORE_AS_DRAFT_WARNING,
  };
};

export const preflightTrashOperation = async (
  context: TrashPreflightContext,
  operation: TrashOperation,
  index: number
): Promise<OperationPreflight> => {
  const collection = trashable(context.info, operation);
  const target = trashTarget(operation);
  const current = await readCurrent(context, operation);
  const stamp = requireStamp(current, target);

  if (operation.expected_updated_at !== stamp) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${target} was last updated at ${stamp}`
    );
  }

  const seen = { collection, current };

  const shown =
    operation.kind === "trash"
      ? await preflightTrash(context, operation, seen)
      : preflightRestore(operation, seen);

  const preview: OperationPreflight = {
    ...shown,
    editUrl: context.adminUrl(operation.collection, operation.id),
    editor: "Payload admin",
    modifiedGmt: stamp,
    operationIndex: index,
    sentence: trashSentence(operation),
    slug: slugOf(current),
    target,
  };

  // A document in the trash has no page to preview.
  const previewUrl =
    operation.kind === "trash"
      ? await previewLink(context, collection, operation.id)
      : "";

  if (previewUrl) {
    preview.previewUrl = previewUrl;
  }

  return preview;
};

const JSON_WRITE = { "Content-Type": "application/json" } as const;

// What each operation saves. A restore names every locale, so a site that
// keeps a status per locale gets the whole document back in one state.
interface TrashWrite {
  body: JsonObject;
  query: string;
}

const writeOf = (operation: TrashOperation): TrashWrite => {
  if (operation.kind === "trash") {
    return { body: { [TRASH_FIELD]: new Date().toISOString() }, query: "" };
  }

  return operation.publish
    ? {
        body: { [STATUS_FIELD]: "published", [TRASH_FIELD]: null },
        query: "&trash=true&publishAllLocales=true",
      }
    : {
        body: { [STATUS_FIELD]: "draft", [TRASH_FIELD]: null },
        query: "&trash=true&unpublishAllLocales=true",
      };
};

const send = async (
  context: TrashContext,
  operation: TrashOperation,
  target: string
): Promise<string | undefined> => {
  const { body, query } = writeOf(operation);

  const write = await payloadRest(
    context.client,
    `${documentPath(operation.collection, operation.id, false)}${query}`,
    context.telemetry,
    { body: JSON.stringify(body), headers: JSON_WRITE, method: "PATCH" }
  );

  if (write.status === LOCKED_STATUS) {
    throw lockedError(target);
  }

  if (write.status < 200 || write.status >= 300) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  return writtenStamp(write);
};

type LandedFacts = Pick<
  OperationReceipt,
  "details" | "updated_at" | "version_id"
>;

interface Landed {
  after: JsonObject;
  facts: LandedFacts;
}

const landed = async (
  context: TrashContext,
  operation: TrashOperation,
  collection: CollectionEditing,
  stamp: string | undefined
): Promise<Landed> => {
  const trashed = operation.kind === "trash";

  const [after, versionId, previewUrl] = await Promise.all([
    readTrashable(
      context.client,
      operation.collection,
      operation.id,
      context.telemetry
    ),
    writtenVersionId(
      context.client,
      operation.collection,
      { id: operation.id, stamp, trashed },
      context.telemetry
    ),
    trashed ? "" : previewLink(context, collection, operation.id),
  ]);

  const facts: LandedFacts = {};
  const updated = updatedAt(after);

  if (updated !== undefined) {
    facts.updated_at = updated;
  }

  if (versionId !== undefined) {
    facts.version_id = versionId;
  }

  const details = receiptDetails({ preview_url: previewUrl });

  if (details) {
    facts.details = details;
  }

  return { after, facts };
};

// What went wrong when Payload answered the write but the document is not
// where the operation was to put it.
const missed = async (
  context: TrashContext,
  operation: TrashOperation,
  after: JsonObject
): Promise<ReceiptError | undefined> => {
  const target = trashTarget(operation);
  const inTrash = trashedAt(after) !== undefined;

  if (operation.kind === "trash") {
    return inTrash
      ? undefined
      : {
          code: "not_trashed",
          message: `Payload answered the write, but ${target} is not in the trash`,
        };
  }

  if (inTrash) {
    return {
      code: "still_in_trash",
      message: `Payload answered the write, but ${target} is still in the trash`,
    };
  }

  // The approval said where the document's public page would be once it
  // was restored. A hook, or access to `_status`, can leave it elsewhere.
  const published = await isPublic(context, operation);

  if (operation.publish) {
    return published
      ? undefined
      : {
          code: "not_published",
          message: `Payload restored ${target} as a draft but did not publish it`,
        };
  }

  return published
    ? {
        code: "still_published",
        message: `Payload restored ${target}, but as published and not as a draft: its public page is being served`,
      }
    : undefined;
};

// What a restore reports when the document left the trash but not as it
// was asked to.
const LEFT_TRASH = new Set(["not_published", "still_published"]);

export const applyTrashOperation = async (
  context: TrashContext,
  operation: TrashOperation,
  snapshot: OperationPreflight
): Promise<OperationReceipt> => {
  const outcome = (
    status: OperationReceipt["status"],
    changed: string[],
    error?: ReceiptError
  ): OperationReceipt => {
    const receipt: OperationReceipt = {
      changed_paths: changed,
      kind: operation.kind,
      normalized_paths: [],
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
    outcome(CONFLICT_CODES.has(error.code) ? "conflict" : "failed", [], error);

  if (snapshot.target !== trashTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    // Checked again at write time: the collection's trash, this editor's
    // permissions or the document itself may have changed since the preview.
    const collection = trashable(
      await readEditingInfo(context.client, context.telemetry),
      operation
    );

    const before = await readCurrent(context, operation);

    if (updatedAt(before) !== snapshot.modifiedGmt) {
      throw new ApplyConflictError(
        "modified_since_preflight",
        `${snapshot.target} changed after the approval preview`
      );
    }

    const written = await send(context, operation, snapshot.target);

    const { after, facts } = await landed(
      context,
      operation,
      collection,
      written
    );

    const error = await missed(context, operation, after);

    // A restore that came back with the other status has still left the
    // trash.
    if (error) {
      return {
        ...facts,
        ...outcome(
          "failed",
          LEFT_TRASH.has(error.code) ? [TRASH_FIELD] : [],
          error
        ),
      };
    }

    const publishes =
      operation.kind === "restore_from_trash" && operation.publish === true;

    return {
      ...facts,
      ...outcome(
        "changed",
        publishes ? [STATUS_FIELD, TRASH_FIELD] : [TRASH_FIELD]
      ),
    };
  } catch (error) {
    return failure(toReceiptError(error));
  }
};
