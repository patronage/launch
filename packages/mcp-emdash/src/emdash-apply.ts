import {
  APPLY_CONCURRENCY,
  ApplyConflictError,
  UpstreamRequestError,
  batchStatus,
  deepEqual,
  mapWithConcurrency,
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
  EMDASH_API_PREFIX,
  emdashErrorCode,
  emdashErrorMessage,
  emdashRest,
} from "./emdash";
import {
  operationSentence,
  operationTarget,
  writtenPaths,
} from "./emdash-operations";
import type {
  CreateDraftOperation,
  EmDashOperation,
  PublishOperation,
  UpdateDraftOperation,
} from "./emdash-operations";

// Where the approval page and receipts link: an entry in the EmDash admin,
// and the public origin a preview path is joined to. Empty when unknown.
export interface EmDashLinks {
  adminUrl: (collection: string, id: string) => string;
  siteUrl: string;
}

const STATUS_PATH = "status";

const PUBLISH_WARNING =
  "Approving this publishes the entry: its draft is on the public site at once.";

// EmDash writes a draft revision only on a collection that keeps revisions.
// On any other collection a save writes the live entry, which this connector
// never does without a publish of its own.
const REVISIONS = "revisions";

// EmDash answers these when the entry moved on or another editor holds it.
const CONFLICT_CODES = new Set(["CONFLICT", "ENTRY_LOCKED", "LIST_CONFLICT"]);

const entrySchema = z.object({
  _rev: z.string(),
  item: z.object({
    data: z.record(z.string(), z.json()).catch({}),
    draftRevisionId: z.string().nullish(),
    id: z.string(),
    liveData: z.record(z.string(), z.json()).nullish(),
    slug: z.string().nullish(),
    status: z.string(),
    updatedAt: z.string().optional(),
  }),
});

type Entry = z.infer<typeof entrySchema>;

const successSchema = z.object({ data: z.json(), success: z.literal(true) });

// EmDash's admin manifest, which any signed-in user may read. The schema
// routes need an editor's `schema:read`, which an author doesn't have.
const manifestSchema = z.object({
  collections: z.record(
    z.string(),
    z.object({
      fields: z.record(z.string(), z.json()).catch({}),
      supports: z.array(z.string()).catch([]),
    })
  ),
});

const previewUrlSchema = z.object({ url: z.string() });

const entryPath = (collection: string, id: string): string =>
  `${EMDASH_API_PREFIX}content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;

const json = (body: JsonObject): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

const isOk = (result: UpstreamFetchResult): boolean =>
  result.status >= 200 && result.status < 300;

// A successful response's `data`, or the EmDash error as an ApplyConflictError
// whose code is EmDash's own, so a receipt can tell a conflict from a refusal.
const resultData = (result: UpstreamFetchResult): JsonValue => {
  const parsed = successSchema.safeParse(result.json);

  if (!(isOk(result) && parsed.success)) {
    throw new ApplyConflictError(
      emdashErrorCode(result) ?? `http_${result.status}`,
      emdashErrorMessage(result)
    );
  }

  return parsed.data.data;
};

const readEntry = async (
  client: UpstreamClient,
  collection: string,
  id: string,
  telemetry: UpstreamTelemetry
): Promise<Entry> => {
  const data = resultData(
    await emdashRest(client, entryPath(collection, id), telemetry)
  );

  const entry = entrySchema.safeParse(data);

  if (!entry.success) {
    throw new ApplyConflictError(
      "unexpected_response",
      `EmDash returned an unexpected entry for ${collection}/${id}`
    );
  }

  return entry.data;
};

// The collection's field slugs and what it supports, checked before anyone is
// asked to approve a write to it.
const readCollection = async (
  client: UpstreamClient,
  collection: string,
  telemetry: UpstreamTelemetry
) => {
  const data = resultData(
    await emdashRest(client, `${EMDASH_API_PREFIX}manifest`, telemetry)
  );

  const parsed = manifestSchema.safeParse(data);

  if (!parsed.success) {
    throw new ApplyConflictError(
      "unexpected_response",
      "EmDash returned an unexpected manifest"
    );
  }

  const found = parsed.data.collections[collection];

  if (!found) {
    throw new ApplyConflictError(
      "unknown_collection",
      `EmDash has no collection ${collection}`
    );
  }

  return { fields: Object.keys(found.fields), supports: found.supports };
};

const assertWritableCollection = async (
  client: UpstreamClient,
  operation: CreateDraftOperation | UpdateDraftOperation,
  telemetry: UpstreamTelemetry
): Promise<void> => {
  const collection = await readCollection(
    client,
    operation.collection,
    telemetry
  );

  if (
    operation.kind === "update_draft" &&
    !collection.supports.includes(REVISIONS)
  ) {
    throw new ApplyConflictError(
      "no_draft_revisions",
      `${operation.collection} keeps no revisions, so a save would change the live entry; edit it in the EmDash admin`
    );
  }

  const known = new Set(collection.fields);
  const unknown = writtenPaths(operation).filter((path) => !known.has(path));

  if (unknown.length > 0) {
    throw new ApplyConflictError(
      "unknown_field",
      `${operation.collection} has no field ${unknown.join(", ")}`
    );
  }
};

// The id is the entry's own, never its slug: a batch names each entry once,
// which only holds if two spellings of one entry can't both appear.
const assertEntryId = (entry: Entry, id: string): void => {
  if (entry.item.id !== id) {
    throw new ApplyConflictError(
      "not_an_entry_id",
      `Name the entry by its id (${entry.item.id}), not its slug`
    );
  }
};

const assertExpectedRev = (
  entry: Entry,
  operation: PublishOperation | UpdateDraftOperation
): void => {
  if (
    operation.expected_rev !== undefined &&
    operation.expected_rev !== entry._rev
  ) {
    throw new ApplyConflictError(
      "stale_expected_rev",
      `${operation.collection}/${operation.id} changed since it was read (its _rev is now ${entry._rev})`
    );
  }
};

const snapshot = (
  path: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined
): FieldSnapshot => ({
  after: previewValue(after),
  before: previewValue(before),
  changed: !deepEqual(before, after),
  path,
});

// EmDash's signed link to the entry's draft on the front end, for the
// approval page. Optional: without one the approver still has the admin link.
const previewLink = async (
  client: UpstreamClient,
  links: EmDashLinks,
  collection: string,
  id: string,
  telemetry: UpstreamTelemetry
): Promise<string> => {
  if (!links.siteUrl) {
    return "";
  }

  try {
    const result = await emdashRest(
      client,
      `${entryPath(collection, id)}/preview-url`,
      telemetry,
      { ...json({ expiresIn: "1d" }), method: "POST" }
    );

    const parsed = previewUrlSchema.safeParse(resultData(result));

    return parsed.success
      ? new URL(parsed.data.url, links.siteUrl).toString()
      : "";
  } catch {
    return "";
  }
};

const basePreview = (
  operation: EmDashOperation,
  index: number,
  stamp: string,
  fields: FieldSnapshot[],
  slug: string
): OperationPreflight => ({
  editUrl: "",
  editor: "EmDash admin",
  fields,
  modifiedGmt: stamp,
  operationIndex: index,
  sentence: operationSentence(operation, index),
  slug,
  target: operationTarget(operation, index),
});

const withLinks = async (
  preview: OperationPreflight,
  client: UpstreamClient,
  links: EmDashLinks,
  collection: string,
  id: string,
  telemetry: UpstreamTelemetry
): Promise<OperationPreflight> => {
  const editUrl = links.adminUrl(collection, id);

  const previewUrl = await previewLink(
    client,
    links,
    collection,
    id,
    telemetry
  );

  const linked: OperationPreflight = { ...preview, editUrl };

  if (previewUrl) {
    linked.previewUrl = previewUrl;
  }

  return linked;
};

// What publishing changes: each field whose draft differs from what is live,
// or, for an entry never published, every field it has.
const publishFields = (entry: Entry): FieldSnapshot[] => {
  const draft = entry.item.data;
  const live = entry.item.liveData ?? {};
  const neverPublished = entry.item.status !== "published";

  const paths = [
    ...new Set([...Object.keys(draft), ...Object.keys(live)]),
  ].toSorted();

  const fields = paths.flatMap((path) => {
    const field = snapshot(
      path,
      neverPublished ? undefined : live[path],
      draft[path]
    );

    return field.changed ? [field] : [];
  });

  if (neverPublished) {
    fields.push(snapshot(STATUS_PATH, entry.item.status, "published"));
  }

  return fields;
};

const preflightOne = async (
  client: UpstreamClient,
  links: EmDashLinks,
  operation: EmDashOperation,
  index: number,
  telemetry: UpstreamTelemetry
): Promise<OperationPreflight> => {
  if (operation.kind === "create_draft") {
    await assertWritableCollection(client, operation, telemetry);

    return basePreview(
      operation,
      index,
      "",
      writtenPaths(operation).map((path) =>
        snapshot(path, undefined, operation.fields[path])
      ),
      operation.slug ?? ""
    );
  }

  if (operation.kind === "update_draft") {
    await assertWritableCollection(client, operation, telemetry);
  }

  const entry = await readEntry(
    client,
    operation.collection,
    operation.id,
    telemetry
  );

  assertEntryId(entry, operation.id);
  assertExpectedRev(entry, operation);

  const slug = entry.item.slug ?? "";

  if (operation.kind === "update_draft") {
    const fields = writtenPaths(operation).map((path) =>
      snapshot(path, entry.item.data[path], operation.fields[path])
    );

    return await withLinks(
      basePreview(operation, index, entry._rev, fields, slug),
      client,
      links,
      operation.collection,
      operation.id,
      telemetry
    );
  }

  if (entry.item.status === "published" && !entry.item.draftRevisionId) {
    throw new ApplyConflictError(
      "nothing_to_publish",
      `${operation.collection}/${operation.id} is published and has no draft to publish`
    );
  }

  const preview = await withLinks(
    basePreview(operation, index, entry._rev, publishFields(entry), slug),
    client,
    links,
    operation.collection,
    operation.id,
    telemetry
  );

  return { ...preview, warning: PUBLISH_WARNING };
};

export const preflightOperations = async (
  client: UpstreamClient,
  intent: string,
  operations: EmDashOperation[],
  links: EmDashLinks,
  telemetry: UpstreamTelemetry
): Promise<ApplyPreflight> => ({
  intent,
  operations: await mapWithConcurrency(
    operations,
    APPLY_CONCURRENCY,
    (operation, index) =>
      preflightOne(client, links, operation, index, telemetry)
  ),
});

// Receipts never carry an EmDash response body: a known failure keeps its
// code and EmDash's bounded message, anything else a fixed sentence.
const receiptError = <E>(error: E): ReceiptError => {
  if (error instanceof ApplyConflictError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof UpstreamRequestError) {
    return { code: "emdash_request_failed", message: error.message };
  }

  return { code: "unexpected_error", message: "The operation failed" };
};

const receiptStatus = <E>(error: E): OperationReceipt["status"] =>
  error instanceof ApplyConflictError && CONFLICT_CODES.has(error.code)
    ? "conflict"
    : "failed";

interface Readback {
  changed: string[];
  missed: string[];
  normalized: string[];
}

// The same reading as the other connectors': a stored value equal to the
// request landed, one still equal to the old value was ignored, and anything
// else is EmDash's own normalisation of what landed.
const classifyReadback = (
  requested: JsonObject,
  before: JsonObject,
  after: JsonObject
): Readback => {
  const readback: Readback = { changed: [], missed: [], normalized: [] };

  for (const path of Object.keys(requested).toSorted()) {
    const value = requested[path];

    if (deepEqual(before[path], value)) {
      continue;
    }

    if (deepEqual(after[path], value)) {
      readback.changed.push(path);
    } else if (deepEqual(after[path], before[path])) {
      readback.missed.push(path);
    } else {
      readback.changed.push(path);
      readback.normalized.push(path);
    }
  }

  return readback;
};

const MISSED_PATH_LIMIT = 5;

const missedMessage = (missed: string[]): string => {
  const listed = missed.slice(0, MISSED_PATH_LIMIT);
  const extra = missed.length - listed.length;

  return `EmDash did not store ${listed.join(", ")}${extra > 0 ? ` and ${extra} more` : ""}`;
};

const landed = (
  base: Pick<OperationReceipt, "kind" | "operation_index" | "target">,
  entry: Entry,
  readback: Readback,
  links: EmDashLinks,
  collection: string
): OperationReceipt => {
  const editUrl = links.adminUrl(collection, entry.item.id);

  const receipt: OperationReceipt = {
    ...base,
    changed_paths: readback.changed,
    details: {
      id: entry.item.id,
      rev: entry._rev,
      status: entry.item.status,
    },
    normalized_paths: readback.normalized,
    status: readback.changed.length > 0 ? "changed" : "unchanged",
  };

  if (editUrl && receipt.details) {
    receipt.details.edit_url = editUrl;
  }

  if (entry.item.updatedAt) {
    receipt.updated_at = entry.item.updatedAt;
  }

  if (readback.missed.length > 0) {
    receipt.status = "failed";
    receipt.error = {
      code: "readback_mismatch",
      message: missedMessage(readback.missed),
    };
  }

  return receipt;
};

// The entry as the preview saw it, or a conflict: EmDash checks `_rev` again
// on the write itself, so this only spares a doomed request.
const readUnchanged = async (
  client: UpstreamClient,
  operation: PublishOperation | UpdateDraftOperation,
  preview: OperationPreflight,
  telemetry: UpstreamTelemetry
): Promise<Entry> => {
  const entry = await readEntry(
    client,
    operation.collection,
    operation.id,
    telemetry
  );

  if (entry._rev !== preview.modifiedGmt) {
    throw new ApplyConflictError(
      "CONFLICT",
      `${preview.target} changed after the approval preview`
    );
  }

  return entry;
};

const applyUpdate = async (
  client: UpstreamClient,
  operation: UpdateDraftOperation,
  preview: OperationPreflight,
  telemetry: UpstreamTelemetry
) => {
  const before = await readUnchanged(client, operation, preview, telemetry);

  resultData(
    await emdashRest(
      client,
      entryPath(operation.collection, operation.id),
      telemetry,
      {
        ...json({ _rev: preview.modifiedGmt, data: operation.fields }),
        method: "PUT",
      }
    )
  );

  const after = await readEntry(
    client,
    operation.collection,
    operation.id,
    telemetry
  );

  return {
    after,
    readback: classifyReadback(
      operation.fields,
      before.item.data,
      after.item.data
    ),
  };
};

const createdIdSchema = z.object({ item: z.object({ id: z.string() }) });

const applyCreate = async (
  client: UpstreamClient,
  operation: CreateDraftOperation,
  telemetry: UpstreamTelemetry
) => {
  const body: JsonObject = { data: operation.fields, status: "draft" };

  if (operation.slug) {
    body.slug = operation.slug;
  }

  const created = createdIdSchema.safeParse(
    resultData(
      await emdashRest(
        client,
        `${EMDASH_API_PREFIX}content/${encodeURIComponent(operation.collection)}`,
        telemetry,
        { ...json(body), method: "POST" }
      )
    )
  );

  if (!created.success) {
    throw new ApplyConflictError(
      "unexpected_response",
      `EmDash created a ${operation.collection} entry but did not say which`
    );
  }

  const after = await readEntry(
    client,
    operation.collection,
    created.data.item.id,
    telemetry
  );

  return {
    after,
    readback: classifyReadback(operation.fields, {}, after.item.data),
  };
};

const applyPublish = async (
  client: UpstreamClient,
  operation: PublishOperation,
  preview: OperationPreflight,
  telemetry: UpstreamTelemetry
) => {
  await readUnchanged(client, operation, preview, telemetry);

  resultData(
    await emdashRest(
      client,
      `${entryPath(operation.collection, operation.id)}/publish`,
      telemetry,
      { ...json({ _rev: preview.modifiedGmt }), method: "POST" }
    )
  );

  const after = await readEntry(
    client,
    operation.collection,
    operation.id,
    telemetry
  );

  const published =
    after.item.status === "published" && !after.item.draftRevisionId;

  const paths = preview.fields
    .filter((field) => field.changed)
    .map((field) => field.path);

  return {
    after,
    readback: published
      ? { changed: paths, missed: [], normalized: [] }
      : { changed: [], missed: [STATUS_PATH], normalized: [] },
  };
};

const written = (
  client: UpstreamClient,
  operation: EmDashOperation,
  preview: OperationPreflight,
  telemetry: UpstreamTelemetry
) => {
  if (operation.kind === "create_draft") {
    return applyCreate(client, operation, telemetry);
  }

  if (operation.kind === "update_draft") {
    return applyUpdate(client, operation, preview, telemetry);
  }

  return applyPublish(client, operation, preview, telemetry);
};

const applyOne = async (
  client: UpstreamClient,
  links: EmDashLinks,
  operation: EmDashOperation,
  preview: OperationPreflight | undefined,
  index: number,
  telemetry: UpstreamTelemetry
): Promise<OperationReceipt> => {
  const base = {
    kind: operation.kind,
    operation_index: index,
    target: operationTarget(operation, index),
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

  if (preview === undefined) {
    return failure({
      code: "missing_preflight",
      message: "No approval preview exists for this operation",
    });
  }

  // The preview is stored at approval and the operations arrive at apply, so
  // nothing else guarantees preview i describes operation i.
  if (preview.target !== base.target) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    const { after, readback } = await written(
      client,
      operation,
      preview,
      telemetry
    );

    return landed(base, after, readback, links, operation.collection);
  } catch (error) {
    return failure(receiptError(error), receiptStatus(error));
  }
};

// Operations run `APPLY_CONCURRENCY` at a time and the receipt lists them in
// index order: a batch names each entry once, and each write checks its own.
export const applyOperations = async (options: {
  approverOpaque: string;
  client: UpstreamClient;
  executionId: string;
  links: EmDashLinks;
  onProgress?: (receipt: OperationReceipt) => Promise<void>;
  operations: EmDashOperation[];
  preflight: ApplyPreflight;
  requesterOpaque: string;
  telemetry: UpstreamTelemetry;
}): Promise<BatchReceipt> => {
  const receipts = await mapWithConcurrency(
    options.operations,
    APPLY_CONCURRENCY,
    async (operation, index) => {
      const receipt = await applyOne(
        options.client,
        options.links,
        operation,
        options.preflight.operations.at(index),
        index,
        options.telemetry
      );

      try {
        await options.onProgress?.(receipt);
      } catch {
        // Progress is a view of the write, not part of it.
      }

      return receipt;
    }
  );

  return {
    approverOpaque: options.approverOpaque,
    executionId: options.executionId,
    operations: receipts,
    requesterOpaque: options.requesterOpaque,
    status: batchStatus(receipts),
  };
};
