import {
  ApplyConflictError,
  deepEqual,
  receiptDetails,
} from "@patronage/mcp-core";
import type {
  JsonObject,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";

import { payloadErrorMessage, payloadRest } from "./payload";
import {
  classifyReadback,
  CONFLICT_CODES,
  globalPath,
  LOCKED_STATUS,
  lockedError,
  missedPathsMessage,
  publishSnapshot,
  readGlobal,
  requireStamp,
  toReceiptError,
  updatedAt,
  writtenGlobalVersionId,
  writtenStamp,
} from "./payload-documents";
import { readEditingInfo } from "./payload-editing";
import type { EditingInfo, GlobalEditing } from "./payload-editing";
import {
  draftFields,
  globalFieldPaths,
  globalSentence,
  globalTarget,
  STATUS_FIELD,
} from "./payload-operations";
import type { UpdateGlobalOperation } from "./payload-operations";
import { fieldSnapshot } from "./payload-relations";
import type { TitleLookup } from "./payload-relations";
import { patchRows, readBackRows } from "./payload-rows";
import type { RowContext, RowConverters, RowsPatch } from "./payload-rows";
import { insertedRows } from "./payload-rows-apply";

// `update_global`: a change to a global, the one document of its own kind
// that holds site settings, a footer or the like. Top-level fields are set
// as Payload stores them, and rows of its array and blocks fields are
// changed as `patch_rows` changes a document's. A global with drafts is
// saved as a draft unless the operation publishes. A global without drafts
// is live the moment it is saved, so there the operation must say
// `publish: true`, and the approver is told so above the change. A global
// another editor has open in the admin is refused.

export type PayloadGlobalAdminUrl = (slug: string) => string;

export interface GlobalContext {
  client: UpstreamClient;
  telemetry: UpstreamTelemetry;
}

export interface GlobalPreflightContext extends GlobalContext {
  globalAdminUrl: PayloadGlobalAdminUrl;
  info: EditingInfo;
  titles: TitleLookup;
}

export const NO_DRAFTS_WARNING =
  "This global has no drafts: the change is live as soon as you approve.";

// A write to a global, of any kind: which one, and whether it publishes.
export interface GlobalWrite {
  global: string;
  publish?: true | undefined;
}

export const editableGlobal = (
  info: EditingInfo,
  operation: GlobalWrite
): GlobalEditing => {
  const global = info.globals.find((entry) => entry.slug === operation.global);

  if (!global) {
    throw new ApplyConflictError(
      "unknown_global",
      `${operation.global} is not a global this editor can read`
    );
  }

  if (!global.canUpdate) {
    throw new ApplyConflictError(
      "not_permitted",
      `This editor may not update the ${operation.global} global`
    );
  }

  if (!(global.drafts || operation.publish)) {
    throw new ApplyConflictError(
      "publish_required",
      `The ${operation.global} global has no drafts, so a change there is live as soon as it is saved; send publish: true when the person asked for that`
    );
  }

  // Payload's REST endpoint for a global saves over another editor's lock
  // and removes it, where the one for a document answers 423. So the lock
  // is read from `getEditingInfo` first, here and again just before the
  // write, and a locked global is left alone.
  if (global.locked === undefined) {
    throw new ApplyConflictError(
      "lock_unknown",
      `This site's Payload does not say whether another editor has the ${operation.global} global open, and Payload saves a global over an editor's lock; update the site's getEditingInfo tool`
    );
  }

  if (global.locked) {
    throw lockedError(`globals/${operation.global}`);
  }

  return global;
};

// A row path always goes through a row, so the global's own rich text
// fields never come into it.
const rowContext = (global: GlobalEditing): RowContext => ({
  richTextFields: [],
  rowFields: global.rowFields,
});

const noMarkdown = (): Promise<never> =>
  Promise.reject(
    new ApplyConflictError(
      "not_rich_text",
      "Markdown is not converted for a global; set the field as Payload stores it"
    )
  );

// The operation's schema refuses `set_markdown` in a global: Payload's
// Markdown tools convert for a collection's fields only.
const converters: RowConverters = {
  toMarkdown: noMarkdown,
  toRichText: noMarkdown,
};

const patchGlobalRows = (
  record: JsonObject,
  global: GlobalEditing,
  operation: UpdateGlobalOperation
): Promise<RowsPatch> =>
  patchRows(record, rowContext(global), operation.changes ?? [], converters);

// Whether the write publishes a draft. A global without drafts has no
// `_status` to set: every save of it is the published one.
const publishesDraft = (
  global: GlobalEditing,
  operation: UpdateGlobalOperation
): boolean => global.drafts && operation.publish === true;

export const preflightGlobal = async (
  context: GlobalPreflightContext,
  operation: UpdateGlobalOperation,
  index: number
): Promise<OperationPreflight> => {
  const global = editableGlobal(context.info, operation);
  const target = globalTarget(operation);

  const record = await readGlobal(
    context.client,
    operation.global,
    context.telemetry
  );

  const stamp = requireStamp(record, target);

  if (operation.expected_updated_at !== stamp) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${target} was last updated at ${stamp}`
    );
  }

  const values = draftFields(operation);

  const fields = await Promise.all(
    globalFieldPaths(operation).map((path) =>
      fieldSnapshot(context.titles, global.relationFields, path, {
        after: values[path],
        before: record[path],
      })
    )
  );

  const patch = await patchGlobalRows(record, global, operation);

  const preview: OperationPreflight = {
    editUrl: context.globalAdminUrl(operation.global),
    editor: "Payload admin",
    fields: [
      ...fields,
      ...patch.snapshots,
      ...(publishesDraft(global, operation) ? [publishSnapshot(record)] : []),
    ],
    modifiedGmt: stamp,
    operationIndex: index,
    sentence: globalSentence(operation),
    slug: operation.global,
    target,
  };

  if (!global.drafts) {
    preview.warning = NO_DRAFTS_WARNING;
  }

  return preview;
};

interface Written {
  after: JsonObject;
  before: JsonObject;
  // The top-level fields that were sent, without `_status`.
  fields: JsonObject;
  patch: RowsPatch;
  // False when nothing differs and nothing was sent.
  sent: boolean;
  stamp?: string | undefined;
}

// The fields whose value differs from the stored one. A field that is
// already as asked is left out, so a global without drafts is not saved
// again, and given a new version, for a change that is none.
const changedFields = (
  operation: UpdateGlobalOperation,
  before: JsonObject
): JsonObject => {
  const body: JsonObject = {};

  for (const [path, value] of Object.entries(draftFields(operation))) {
    if (value !== undefined && !deepEqual(before[path], value)) {
      body[path] = value;
    }
  }

  return body;
};

const writeGlobal = async (
  context: GlobalContext,
  operation: UpdateGlobalOperation,
  snapshot: OperationPreflight,
  global: GlobalEditing
): Promise<Written> => {
  const { client, telemetry } = context;
  const before = await readGlobal(client, operation.global, telemetry);

  if (updatedAt(before) !== snapshot.modifiedGmt) {
    throw new ApplyConflictError(
      "modified_since_preflight",
      `${snapshot.target} changed after the approval preview`
    );
  }

  // Made again on the global as it is now, which is the one the approver
  // saw: its `updatedAt` has not moved.
  const patch = await patchGlobalRows(before, global, operation);
  const fields = changedFields(operation, before);
  const body: JsonObject = { ...fields };

  for (const field of patch.touched) {
    const value = patch.working[field];

    if (value !== undefined) {
      body[field] = value;
    }
  }

  const publishes = publishesDraft(global, operation);

  if (publishes) {
    body[STATUS_FIELD] = "published";
  }

  if (Object.keys(body).length === 0) {
    return { after: before, before, fields, patch, sent: false };
  }

  // A draft is saved only where the global keeps drafts and the operation
  // does not publish. Payload ignores `draft=true` on a global without them.
  const write = await payloadRest(
    client,
    globalPath(operation.global, global.drafts && !publishes),
    telemetry,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );

  if (write.status === LOCKED_STATUS) {
    throw lockedError(snapshot.target);
  }

  if (write.status < 200 || write.status >= 300) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  return {
    after: await readGlobal(client, operation.global, telemetry),
    before,
    fields,
    patch,
    sent: true,
    stamp: writtenStamp(write),
  };
};

type LandedFacts = Pick<
  OperationReceipt,
  "details" | "updated_at" | "version_id"
>;

const landedFacts = async (
  context: GlobalContext,
  operation: UpdateGlobalOperation,
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

  const versionId = await writtenGlobalVersionId(
    context.client,
    operation.global,
    written.stamp,
    context.telemetry
  );

  if (versionId !== undefined) {
    facts.version_id = versionId;
  }

  const details = receiptDetails({ ...insertedRows(inserted) });

  if (details) {
    facts.details = details;
  }

  return facts;
};

interface Paths {
  changed: string[];
  inserted: string[];
  missed: string[];
  normalized: string[];
}

// What landed, read back from the global as Payload stored it: the fields,
// then the rows, then `_status` when the write published a draft.
const readBack = (
  written: Written,
  global: GlobalEditing,
  published: boolean
): Paths => {
  const fields = classifyReadback(
    written.fields,
    written.before,
    written.after
  );

  const rows = readBackRows(written.patch, written.after, rowContext(global));

  return {
    changed: [
      ...fields.changed,
      ...rows.changed,
      ...(published ? [STATUS_FIELD] : []),
    ],
    inserted: rows.inserted,
    missed: [...fields.missed, ...rows.missed],
    normalized: [...fields.normalized, ...rows.normalized],
  };
};

export const applyGlobal = async (
  context: GlobalContext,
  operation: UpdateGlobalOperation,
  snapshot: OperationPreflight
): Promise<OperationReceipt> => {
  const outcome = (
    status: OperationReceipt["status"],
    paths: Pick<Paths, "changed" | "normalized">,
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

  if (snapshot.target !== globalTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    // Checked again at write time: the global's drafts or this editor's
    // permissions may have changed since the preview.
    const global = editableGlobal(
      await readEditingInfo(context.client, context.telemetry),
      operation
    );

    const written = await writeGlobal(context, operation, snapshot, global);
    const publishes = publishesDraft(global, operation);
    const isPublished = written.after[STATUS_FIELD] === "published";

    const paths = readBack(
      written,
      global,
      publishes && isPublished && written.before[STATUS_FIELD] !== "published"
    );

    const landed = await landedFacts(
      context,
      operation,
      written,
      paths.inserted
    );

    // A hook or field access can keep `_status` a draft. A requested
    // publish must have landed.
    if (publishes && !isPublished) {
      return {
        ...landed,
        ...outcome("failed", paths, {
          code: "not_published",
          message: `Payload saved ${snapshot.target} but did not publish it`,
        }),
      };
    }

    if (paths.missed.length > 0) {
      return {
        ...landed,
        ...outcome("failed", paths, {
          code: "readback_mismatch",
          message: missedPathsMessage(paths.missed),
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
