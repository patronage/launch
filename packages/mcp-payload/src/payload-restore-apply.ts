import {
  ApplyConflictError,
  deepEqual,
  previewValue,
  receiptDetails,
} from "@patronage/mcp-core";
import type {
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

import { payloadErrorMessage, payloadRest } from "./payload";
import {
  assertDraftDocument,
  classifyReadback,
  CONFLICT_CODES,
  documentPath,
  draftCollection,
  globalPath,
  LOCKED_STATUS,
  lockedError,
  missedPathsMessage,
  previewLink,
  publishSnapshot,
  readDocument,
  readGlobal,
  requireStamp,
  toReceiptError,
  updatedAt,
  writtenGlobalVersionId,
  writtenStamp,
  writtenVersionId,
} from "./payload-documents";
import type { PayloadAdminUrl, PayloadSiteUrl } from "./payload-documents";
import { readDocumentLock, readEditingInfo } from "./payload-editing";
import type { EditingInfo } from "./payload-editing";
import { editableGlobal, NO_DRAFTS_WARNING } from "./payload-global-apply";
import type { PayloadGlobalAdminUrl } from "./payload-global-apply";
import {
  restoreSentence,
  restoreTarget,
  STATUS_FIELD,
} from "./payload-operations";
import type { RestoreOperation } from "./payload-operations";
import { fieldSnapshot } from "./payload-relations";
import type { TitleLookup } from "./payload-relations";
import { readableMarkdown } from "./payload-rich-text";

// `restore_version` and `restore_global_version`: bring back an earlier
// version of a document or a global, through Payload's own restore route.
//
// Where the target keeps drafts the restore is always sent with
// `draft=true`, which saves the version's content as a new draft and leaves
// what is published alone. Without that flag Payload gives the document the
// status the version had, so restoring a version that was a draft would
// take a published document off the site. An operation that publishes
// therefore restores as a draft first and then publishes that draft, in a
// second write.
//
// A global without drafts is live the moment it is restored, so there the
// operation must say `publish: true`, as `update_global` must.
//
// Payload's restore route does not look at editor locks, so the gateway
// asks first and leaves alone what another editor has open.

export interface RestoreContext {
  client: UpstreamClient;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

export interface RestorePreflightContext extends RestoreContext {
  adminUrl: PayloadAdminUrl;
  globalAdminUrl: PayloadGlobalAdminUrl;
  info: EditingInfo;
  titles: TitleLookup;
}

type RelationFields = Parameters<typeof fieldSnapshot>[1];

// What is being restored, with the differences between a document and a
// global folded away.
interface Subject {
  // Whether a restore can be saved as a draft, apart from what is published.
  drafts: boolean;
  // Whether any field holds a value for each of the site's locales.
  localized: boolean;
  relationFields: RelationFields;
  // Top-level rich text fields Payload can show as Markdown.
  richTextFields: string[];
  // Top-level array and blocks fields.
  rowFields: string[];
  target: string;
}

const FILE_REFUSAL =
  "holds files, and restoring a version of a file is not supported; replace the file with replace_media_file";

const subjectOf = (info: EditingInfo, operation: RestoreOperation): Subject => {
  const target = restoreTarget(operation);

  if (operation.kind === "restore_global_version") {
    const global = editableGlobal(info, operation);

    return {
      drafts: global.drafts,
      localized: global.localized,
      relationFields: global.relationFields,
      // Payload's Markdown tools convert for a collection's fields only.
      richTextFields: [],
      rowFields: global.rowFields.map((field) => field.path),
      target,
    };
  }

  const collection = draftCollection(info, operation.collection);

  if (!collection.canUpdate) {
    throw new ApplyConflictError(
      "not_permitted",
      `This editor may not update ${operation.collection}`
    );
  }

  if (collection.upload) {
    throw new ApplyConflictError(
      "not_supported",
      `${operation.collection} ${FILE_REFUSAL}`
    );
  }

  return {
    drafts: true,
    localized: collection.localized,
    relationFields: collection.relationFields,
    richTextFields: collection.richTextFields,
    rowFields: collection.rowFields.map((field) => field.path),
    target,
  };
};

const readCurrent = async (
  context: RestoreContext,
  operation: RestoreOperation
): Promise<JsonObject> => {
  if (operation.kind === "restore_global_version") {
    return await readGlobal(
      context.client,
      operation.global,
      context.telemetry
    );
  }

  const record = await readDocument(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  assertDraftDocument(record, operation.collection);

  return record;
};

const versionsPath = (operation: RestoreOperation): string =>
  operation.kind === "restore_global_version"
    ? `/api/globals/${encodeURIComponent(operation.global)}/versions`
    : `/api/${encodeURIComponent(operation.collection)}/versions`;

const versionPath = (operation: RestoreOperation): string =>
  `${versionsPath(operation)}/${encodeURIComponent(String(operation.version_id))}`;

const recordSchema = z.record(z.string(), z.json());

const versionSchema = z.object({
  // A document's version names the document it belongs to. A global's
  // versions are all its own.
  parent: z.union([z.number(), z.string()]).optional(),
  version: recordSchema,
});

// The version to restore, as this editor may read it. One that belongs to
// another document is refused: Payload would restore that document instead.
const readVersion = async (
  context: RestoreContext,
  operation: RestoreOperation
): Promise<JsonObject> => {
  const target = restoreTarget(operation);

  const result = await payloadRest(
    context.client,
    `${versionPath(operation)}?depth=0`,
    context.telemetry
  );

  const parsed = versionSchema.safeParse(result.json);

  if (result.status === 404) {
    throw new ApplyConflictError(
      "unknown_version",
      `Version ${operation.version_id} of ${target} was not found`
    );
  }

  if (result.status !== 200 || !parsed.success) {
    throw new ApplyConflictError("read_failed", payloadErrorMessage(result));
  }

  if (
    operation.kind === "restore_version" &&
    String(parsed.data.parent) !== String(operation.id)
  ) {
    throw new ApplyConflictError(
      "version_of_another_document",
      `Version ${operation.version_id} is not a version of ${target}`
    );
  }

  return parsed.data.version;
};

// Refused while another editor has the target open. A global's lock comes
// with its editing info (`editableGlobal`); a document's is asked for.
const assertUnlocked = async (
  context: RestoreContext,
  operation: RestoreOperation
): Promise<void> => {
  if (operation.kind !== "restore_version") {
    return;
  }

  const locked = await readDocumentLock(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  if (locked === undefined) {
    throw new ApplyConflictError(
      "lock_unknown",
      `This site's Payload does not say whether another editor has ${restoreTarget(operation)} open, and Payload restores a version over an editor's lock; add the getDocumentLock tool to the site`
    );
  }

  if (locked) {
    throw lockedError(restoreTarget(operation));
  }
};

// Fields Payload keeps itself. A restore does not carry them over: the
// restored document gets its own `updatedAt`, and its status is decided by
// how the restore is sent.
const KEPT_BY_PAYLOAD = new Set([
  "_status",
  "createdAt",
  "createdBy",
  "globalType",
  "id",
  "updatedAt",
  "updatedBy",
]);

// A field the version does not hold reads as empty, the way Payload answers
// for a field with no value.
const valueOf = (record: JsonObject, path: string): JsonValue =>
  record[path] ?? null;

// The top-level fields whose value in the version differs from the current
// one, with the version's value: what the restore changes.
const restoredFields = (
  current: JsonObject,
  version: JsonObject
): JsonObject => {
  const fields: JsonObject = {};

  const paths = new Set([...Object.keys(current), ...Object.keys(version)]);

  for (const path of [...paths].toSorted()) {
    if (
      !KEPT_BY_PAYLOAD.has(path) &&
      !deepEqual(valueOf(current, path), valueOf(version, path))
    ) {
      fields[path] = valueOf(version, path);
    }
  }

  return fields;
};

const rowSchema = z.object({ id: z.string().optional() }).loose();
const rowsSchema = z.array(rowSchema);

type Row = z.infer<typeof rowSchema>;

const countOf = (rows: Row[]): string =>
  `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;

// What the version does to the rows of an array or blocks field, by row id.
const rowsDifference = (before: Row[], after: Row[]): string => {
  const earlier = new Map(before.map((row) => [row.id, row]));
  const later = new Set(after.map((row) => row.id));
  const added = after.filter((row) => !earlier.has(row.id)).length;
  const removed = before.filter((row) => !later.has(row.id)).length;

  const changed = after.filter((row) => {
    const was = earlier.get(row.id);

    return was !== undefined && !deepEqual(was, row);
  }).length;

  const parts = [
    ...(added > 0 ? [`${added} not in the current draft`] : []),
    ...(removed > 0 ? [`${removed} of the current ones gone`] : []),
    ...(changed > 0 ? [`${changed} changed`] : []),
  ];

  return parts.length > 0 ? parts.join(", ") : "in another order";
};

// An array or blocks field is too long to show whole on either side, and
// cut short both sides would often read the same. Its rows are counted.
const rowsSnapshot = (
  path: string,
  values: { after: JsonValue; before: JsonValue }
): FieldSnapshot | undefined => {
  const before = rowsSchema.safeParse(values.before ?? []);
  const after = rowsSchema.safeParse(values.after ?? []);

  if (!(before.success && after.success)) {
    return undefined;
  }

  return {
    after: `${countOf(after.data)}: ${rowsDifference(before.data, after.data)}`,
    before: countOf(before.data),
    changed: true,
    path,
  };
};

interface SnapshotInput {
  current: JsonObject;
  operation: RestoreOperation;
  path: string;
  subject: Subject;
  version: JsonObject;
}

const snapshotField = async (
  context: RestorePreflightContext,
  input: SnapshotInput
): Promise<FieldSnapshot> => {
  const { operation, path, subject } = input;

  const values = {
    after: valueOf(input.version, path),
    before: valueOf(input.current, path),
  };

  if (
    operation.kind === "restore_version" &&
    subject.richTextFields.includes(path)
  ) {
    const target = { collection: operation.collection, field: path };

    const [before, after] = await Promise.all([
      readableMarkdown(
        context.client,
        target,
        values.before,
        context.telemetry
      ),
      readableMarkdown(context.client, target, values.after, context.telemetry),
    ]);

    return {
      after: previewValue(after),
      before: previewValue(before),
      changed: true,
      path,
    };
  }

  const rows = subject.rowFields.includes(path)
    ? rowsSnapshot(path, values)
    : undefined;

  return (
    rows ??
    (await fieldSnapshot(context.titles, subject.relationFields, path, values))
  );
};

// Payload restores a version whole, and a version holds every locale. The
// preview reads the document and the version in one locale.
export const LOCALES_WARNING =
  "This brings back every locale of the version. The fields below are shown in one locale only.";

const restoreWarning = (subject: Subject): string =>
  [
    ...(subject.drafts ? [] : [NO_DRAFTS_WARNING]),
    ...(subject.localized ? [LOCALES_WARNING] : []),
  ].join(" ");

const VERSION_ROW = "(version)";

const statusNote = (record: JsonObject): string => {
  const status = z.string().safeParse(record[STATUS_FIELD]);

  return status.success ? `, ${status.data}` : "";
};

// The first row of the preview: which version, when it was saved, and what
// it replaces.
const versionSnapshot = (
  operation: RestoreOperation,
  current: JsonObject,
  version: JsonObject
): FieldSnapshot => ({
  after: `version ${operation.version_id}, saved ${previewValue(version.updatedAt)}${statusNote(version)}`,
  before: `saved ${previewValue(current.updatedAt)}${statusNote(current)}`,
  changed: true,
  label: "Version",
  path: VERSION_ROW,
});

const editUrl = (
  context: RestorePreflightContext,
  operation: RestoreOperation
): string =>
  operation.kind === "restore_version"
    ? context.adminUrl(operation.collection, operation.id)
    : context.globalAdminUrl(operation.global);

const documentPreviewLink = (
  context: RestoreContext,
  info: EditingInfo,
  operation: RestoreOperation
): Promise<string> => {
  if (operation.kind !== "restore_version") {
    return Promise.resolve("");
  }

  const collection = info.collections.find(
    (entry) => entry.slug === operation.collection
  );

  return collection
    ? previewLink(context, collection, operation.id)
    : Promise.resolve("");
};

export const preflightRestore = async (
  context: RestorePreflightContext,
  operation: RestoreOperation,
  index: number
): Promise<OperationPreflight> => {
  const subject = subjectOf(context.info, operation);
  const current = await readCurrent(context, operation);
  const stamp = requireStamp(current, subject.target);

  if (operation.expected_updated_at !== stamp) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${subject.target} was last updated at ${stamp}`
    );
  }

  const version = await readVersion(context, operation);
  const paths = Object.keys(restoredFields(current, version));
  const publishes = subject.drafts && operation.publish === true;

  // Both reads hold one locale, so on a localized target an empty list does
  // not show that the other locales match too.
  if (paths.length === 0 && !publishes && !subject.localized) {
    throw new ApplyConflictError(
      "nothing_to_restore",
      `${subject.target} already holds what version ${operation.version_id} holds`
    );
  }

  await assertUnlocked(context, operation);

  const fields = await Promise.all(
    paths.map((path) =>
      snapshotField(context, { current, operation, path, subject, version })
    )
  );

  const slug = z.string().safeParse(current.slug);

  const preview: OperationPreflight = {
    editUrl: editUrl(context, operation),
    editor: "Payload admin",
    fields: [
      versionSnapshot(operation, current, version),
      ...fields,
      ...(publishes ? [publishSnapshot(current)] : []),
    ],
    modifiedGmt: stamp,
    operationIndex: index,
    sentence: restoreSentence(operation),
    slug: slug.success ? slug.data : "",
    target: subject.target,
  };

  const warning = restoreWarning(subject);

  if (warning) {
    preview.warning = warning;
  }

  const previewUrl = await documentPreviewLink(
    context,
    context.info,
    operation
  );

  if (previewUrl) {
    preview.previewUrl = previewUrl;
  }

  return preview;
};

const JSON_WRITE = { "Content-Type": "application/json" } as const;

const assertWritten = (write: UpstreamFetchResult, target: string): void => {
  if (write.status === LOCKED_STATUS) {
    throw lockedError(target);
  }

  if (write.status < 200 || write.status >= 300) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }
};

// Payload answers a document's restore with the document itself, and a
// global's with it under `doc`.
const restoredStamp = (write: UpstreamFetchResult): string | undefined => {
  const wrapped = writtenStamp(write);

  if (wrapped !== undefined) {
    return wrapped;
  }

  const record = recordSchema.safeParse(write.json);

  return record.success ? updatedAt(record.data) : undefined;
};

// Payload's own restore route. With drafts it is always a draft: see the
// note at the top of this file.
const sendRestore = async (
  context: RestoreContext,
  operation: RestoreOperation,
  subject: Subject
): Promise<string | undefined> => {
  const write = await payloadRest(
    context.client,
    `${versionPath(operation)}?depth=0${subject.drafts ? "&draft=true" : ""}`,
    context.telemetry,
    { body: "{}", headers: JSON_WRITE, method: "POST" }
  );

  assertWritten(write, subject.target);

  return restoredStamp(write);
};

// Asked for by name: where a site keeps a status per locale, Payload would
// otherwise publish one locale of a restore that brought back all of them.
const ALL_LOCALES = "&publishAllLocales=true";

// Publishes the draft the restore just saved, the way `update_draft` with
// `publish: true` and no fields publishes the current draft, in every locale.
const sendPublish = async (
  context: RestoreContext,
  operation: RestoreOperation,
  target: string
): Promise<string | undefined> => {
  const body = JSON.stringify({ [STATUS_FIELD]: "published" });

  const write =
    operation.kind === "restore_version"
      ? await payloadRest(
          context.client,
          `${documentPath(operation.collection, operation.id, false)}${ALL_LOCALES}`,
          context.telemetry,
          { body, headers: JSON_WRITE, method: "PATCH" }
        )
      : await payloadRest(
          context.client,
          `${globalPath(operation.global, false)}${ALL_LOCALES}`,
          context.telemetry,
          { body, headers: JSON_WRITE, method: "POST" }
        );

  assertWritten(write, target);

  return writtenStamp(write);
};

const versionMadeAt = (
  context: RestoreContext,
  operation: RestoreOperation,
  stamp: string | undefined
): Promise<string | undefined> =>
  operation.kind === "restore_version"
    ? writtenVersionId(
        context.client,
        operation.collection,
        { id: operation.id, stamp },
        context.telemetry
      )
    : writtenGlobalVersionId(
        context.client,
        operation.global,
        stamp,
        context.telemetry
      );

type LandedFacts = Pick<
  OperationReceipt,
  "details" | "updated_at" | "version_id"
>;

interface Landed {
  after: JsonObject;
  info: EditingInfo;
  // The `updatedAt` Payload reported for the last write this operation made.
  stamp: string | undefined;
}

const landedFacts = async (
  context: RestoreContext,
  operation: RestoreOperation,
  landed: Landed
): Promise<LandedFacts> => {
  const facts: LandedFacts = {};

  const [versionId, previewUrl] = await Promise.all([
    versionMadeAt(context, operation, landed.stamp),
    documentPreviewLink(context, landed.info, operation),
  ]);

  const stamp = updatedAt(landed.after);

  if (stamp !== undefined) {
    facts.updated_at = stamp;
  }

  if (versionId !== undefined) {
    facts.version_id = versionId;
  }

  const details = receiptDetails({
    preview_url: previewUrl,
    restored_version_id: String(operation.version_id),
  });

  if (details) {
    facts.details = details;
  }

  return facts;
};

interface Restored {
  after: JsonObject;
  before: JsonObject;
  // What the restore was to change: each field that differed, with the
  // version's value.
  fields: JsonObject;
  // Why the draft the restore saved could not be published, when it could
  // not.
  publishError?: ReceiptError;
  stamp: string | undefined;
}

// The read after writes that have landed. One failed read does not undo
// them, so it is tried once more before the receipt gives up on them.
const readLanded = async (
  context: RestoreContext,
  operation: RestoreOperation
): Promise<JsonObject> => {
  try {
    return await readCurrent(context, operation);
  } catch {
    return readCurrent(context, operation);
  }
};

// Publishes the draft the restore saved and answers with the stamp to find
// the write by: the publish's own, or the restore's when it did not publish.
const publishRestored = async (
  context: RestoreContext,
  operation: RestoreOperation,
  input: {
    snapshot: OperationPreflight;
    stamp: string | undefined;
    subject: Subject;
  }
): Promise<Pick<Restored, "publishError" | "stamp">> => {
  const { snapshot, stamp, subject } = input;

  try {
    // Publishing takes whatever the newest draft is, so it is only sent
    // while that is still the one the restore saved.
    const draft = await readCurrent(context, operation);

    if (stamp !== undefined && updatedAt(draft) !== stamp) {
      throw new ApplyConflictError(
        "modified_since_restore",
        `${snapshot.target} was saved again right after the restore`
      );
    }

    return { stamp: await sendPublish(context, operation, subject.target) };
  } catch (error) {
    return { publishError: toReceiptError(error), stamp };
  }
};

const restore = async (
  context: RestoreContext,
  operation: RestoreOperation,
  input: { snapshot: OperationPreflight; subject: Subject }
): Promise<Restored> => {
  const { snapshot, subject } = input;
  const before = await readCurrent(context, operation);

  if (updatedAt(before) !== snapshot.modifiedGmt) {
    throw new ApplyConflictError(
      "modified_since_preflight",
      `${snapshot.target} changed after the approval preview`
    );
  }

  const version = await readVersion(context, operation);

  await assertUnlocked(context, operation);

  const fields = restoredFields(before, version);
  const stamp = await sendRestore(context, operation, subject);

  if (!(subject.drafts && operation.publish)) {
    return {
      after: await readCurrent(context, operation),
      before,
      fields,
      stamp,
    };
  }

  // The restore has landed as a draft. A publish that fails now leaves that
  // draft in place, and the receipt says so instead of losing it. Only the
  // publish itself is caught here: a read that fails after it went through
  // is not a publish that failed.
  const published = await publishRestored(context, operation, {
    snapshot,
    stamp,
    subject,
  });

  return {
    after: await readLanded(context, operation),
    before,
    fields,
    ...published,
  };
};

export const applyRestore = async (
  context: RestoreContext,
  operation: RestoreOperation,
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

  if (snapshot.target !== restoreTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    // Checked again at write time: drafts, this editor's permissions or a
    // global's lock may have changed since the preview.
    const info = await readEditingInfo(context.client, context.telemetry);
    const subject = subjectOf(info, operation);
    const restored = await restore(context, operation, { snapshot, subject });

    const read = classifyReadback(
      restored.fields,
      restored.before,
      restored.after
    );

    const publishes = subject.drafts && operation.publish === true;
    const isPublished = restored.after[STATUS_FIELD] === "published";

    const paths = {
      changed: [
        ...read.changed,
        ...(publishes &&
        isPublished &&
        restored.before[STATUS_FIELD] !== "published"
          ? [STATUS_FIELD]
          : []),
      ],
      normalized: read.normalized,
    };

    const landed = await landedFacts(context, operation, {
      after: restored.after,
      info,
      stamp: restored.stamp,
    });

    // A hook, field access or another editor's save can keep the restored
    // draft from being published. The draft is there all the same.
    const notPublished = (): OperationReceipt => ({
      ...landed,
      ...outcome("failed", paths, {
        code: "not_published",
        message: `Payload restored ${snapshot.target} as a draft but did not publish it${restored.publishError ? `: ${restored.publishError.message}` : ""}`,
      }),
    });

    // Said first: after a save by someone else, what is read back is theirs.
    if (restored.publishError) {
      return notPublished();
    }

    if (read.missed.length > 0) {
      return {
        ...landed,
        ...outcome("failed", paths, {
          code: "readback_mismatch",
          message: missedPathsMessage(read.missed),
        }),
      };
    }

    if (publishes && !isPublished) {
      return notPublished();
    }

    return {
      ...landed,
      // On a localized target the restore may have changed locales the
      // readback does not hold, so it is not called unchanged.
      ...outcome(
        paths.changed.length > 0 || subject.localized ? "changed" : "unchanged",
        paths
      ),
    };
  } catch (error) {
    return failure(toReceiptError(error));
  }
};
