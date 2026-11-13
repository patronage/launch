import {
  ApplyConflictError,
  UpstreamRequestError,
  deepEqual,
} from "@patronage/mcp-core";
import type {
  JsonObject,
  ReceiptError,
  UpstreamClient,
  UpstreamFetchResult,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadErrorMessage, payloadRest } from "./payload";
import { readPreviewUrl } from "./payload-editing";
import type { CollectionEditing, EditingInfo } from "./payload-editing";

// Reading and naming Payload documents, shared by every operation kind:
// where a document lives in REST, when it was last updated, which version a
// write made, and how a failure reads on a receipt.

const recordSchema = z.record(z.string(), z.json());
const stringSchema = z.string();
const documentIdSchema = z.union([z.number(), z.string()]);

export type PayloadAdminUrl = (
  collection: string,
  id: number | string
) => string;

// Turns a link Payload made to its own site into an absolute URL, or "" when
// the gateway knows no public origin for it.
export type PayloadSiteUrl = (link: string) => string;

// Payload answers 423 when another editor has the document open: REST
// writes never override a lock.
export const LOCKED_STATUS = 423;

// As long as a receipt's `version_id` may be.
const VERSION_ID_LIMIT = 64;

// Every read names the draft, so it returns the newest version, draft or
// published. A write names it too, saving a new draft version and leaving
// the published one as it is, unless the operation publishes: then the write
// goes without `draft=true` and sets `_status` to published.
export const draftQuery = (draft: boolean): string =>
  draft ? "?draft=true&depth=0" : "?depth=0";

export const documentPath = (
  collection: string,
  id: number | string,
  draft = true
): string =>
  `/api/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}${draftQuery(draft)}`;

export const updatedAt = (record: JsonObject): string | undefined => {
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

export const readDocument = async (
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

export const toReceiptError = <E>(error: E): ReceiptError => {
  if (error instanceof ApplyConflictError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof UpstreamRequestError) {
    return { code: "payload_request_failed", message: error.message };
  }

  return { code: "unexpected_error", message: "The operation failed" };
};

const versionsSchema = z.object({
  docs: z.array(
    z.object({
      id: documentIdSchema,
      version: z.object({ updatedAt: z.string() }),
    })
  ),
});

const writtenSchema = z.object({ doc: recordSchema });

// When Payload says the write itself saved the document: the `updatedAt` of
// the document in the write's own response, which the version that write
// made holds too, as `version.updatedAt`. (The version's own `updatedAt` is
// when the version row was saved: the same moment for a draft, a few
// milliseconds later for a collection without drafts.)
export const writtenStamp = (
  write: UpstreamFetchResult
): string | undefined => {
  const parsed = writtenSchema.safeParse(write.json);

  return parsed.success ? updatedAt(parsed.data.doc) : undefined;
};

export interface WrittenDocument {
  id: number | string;
  // The document's `updatedAt` in the write's own response.
  stamp?: string | undefined;
}

// The version this write made: the one saved at the time the write's own
// response reported. Another editor's save or an autosave can land a moment
// later, so "the newest version" could be theirs; a receipt names a version
// only when it is this write's. A receipt without one is still a true
// receipt, so a failed lookup is no failure.
export const writtenVersionId = async (
  client: UpstreamClient,
  collection: string,
  written: WrittenDocument,
  telemetry: UpstreamTelemetry
): Promise<string | undefined> => {
  if (written.stamp === undefined) {
    return undefined;
  }

  try {
    const result = await payloadRest(
      client,
      `/api/${encodeURIComponent(collection)}/versions?where[parent][equals]=${encodeURIComponent(String(written.id))}&where[version.updatedAt][equals]=${encodeURIComponent(written.stamp)}&limit=1&depth=0&select[version][updatedAt]=true`,
      telemetry
    );

    const parsed = versionsSchema.safeParse(result.json);
    const [version] = parsed.success ? parsed.data.docs : [];

    return result.status === 200 && version?.version.updatedAt === written.stamp
      ? String(version.id).slice(0, VERSION_ID_LIMIT)
      : undefined;
  } catch {
    return undefined;
  }
};

// Nothing was written in either case, and trying again later can work.
export const CONFLICT_CODES = new Set(["locked", "modified_since_preflight"]);

// What a write is refused with when another editor has the document open.
export const lockedError = (target: string): ApplyConflictError =>
  new ApplyConflictError(
    "locked",
    `${target} is open in the Payload admin for another editor; try again once they have finished`
  );

const MISSED_PATH_LIMIT = 5;

export const missedPathsMessage = (missed: string[]): string => {
  const listed = missed.slice(0, MISSED_PATH_LIMIT);
  const extra = missed.length - listed.length;

  return `Payload did not store ${listed.join(", ")}${extra > 0 ? ` and ${extra} more` : ""}`;
};

// The same reading as `wp.apply`'s readback: a stored value equal to the one
// asked for is a change, one still equal to the value before is a miss, and
// anything else is Payload rewriting what it stored (a hook, a sanitiser, or
// Lexical filling in node defaults).
export const classifyReadback = (
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

// Only a collection with drafts keeps the published version apart from the
// one being written. Without drafts, `?draft=true` is ignored and the write
// would go live, so such a collection is refused before anything is shown.
export const draftCollection = (
  info: EditingInfo,
  slug: string
): CollectionEditing => {
  const collection = info.collections.find((entry) => entry.slug === slug);

  if (!collection) {
    throw new ApplyConflictError(
      "unknown_collection",
      `${slug} is not a collection this editor can read`
    );
  }

  if (!collection.drafts) {
    throw new ApplyConflictError(
      "drafts_not_enabled",
      `${slug} has no drafts, so a change there would publish at once`
    );
  }

  return collection;
};

// The same check on the document itself: a draft-enabled collection always
// stores `_status`, so a document without one is refused too.
export const assertDraftDocument = (
  record: JsonObject,
  collection: string
): void => {
  if (!("_status" in record)) {
    throw new ApplyConflictError(
      "drafts_not_enabled",
      `${collection} has no drafts, so a change there would publish at once`
    );
  }
};

export const requireStamp = (record: JsonObject, target: string): string => {
  const stamp = updatedAt(record);

  if (stamp === undefined) {
    throw new ApplyConflictError(
      "unreadable_updated_at",
      `Payload did not report when ${target} was last updated`
    );
  }

  return stamp;
};

interface PreviewContext {
  client: UpstreamClient;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

// The front end's draft preview of the document as it is now, where its
// collection has one. A new document has no address until it is saved.
export const previewLink = async (
  context: PreviewContext,
  collection: Pick<CollectionEditing, "preview" | "slug">,
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
