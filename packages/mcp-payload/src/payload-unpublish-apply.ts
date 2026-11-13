import { ApplyConflictError, receiptDetails } from "@patronage/mcp-core";
import type {
  FieldSnapshot,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadErrorMessage, payloadRest } from "./payload";
import {
  assertDraftDocument,
  CONFLICT_CODES,
  draftCollection,
  LOCKED_STATUS,
  lockedError,
  readDocument,
  requireStamp,
  toReceiptError,
  updatedAt,
  writtenStamp,
  writtenVersionId,
} from "./payload-documents";
import type { PayloadAdminUrl, PayloadSiteUrl } from "./payload-documents";
import { readDocumentAddress, readEditingInfo } from "./payload-editing";
import type {
  CollectionEditing,
  DocumentAddress,
  EditingInfo,
} from "./payload-editing";
import {
  STATUS_FIELD,
  unpublishSentence,
  unpublishTarget,
} from "./payload-operations";
import type { UnpublishOperation } from "./payload-operations";

// `unpublish`: takes a published document off the public site and keeps its
// content as a draft. It is the request the admin's own Unpublish button
// sends: `_status: "draft"` saved to the document itself, with
// `unpublishAllLocales`, which makes Payload carry the newest draft's
// content over and mark the newest version a draft in place instead of
// adding a version. Nothing else about the document changes.

export interface UnpublishContext {
  client: UpstreamClient;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

export interface UnpublishPreflightContext extends UnpublishContext {
  adminUrl: PayloadAdminUrl;
  info: EditingInfo;
}

// One status, or one for each locale where the collection keeps them apart
// and the read asked for every locale.
const statusSchema = z.object({
  _status: z.union([z.string(), z.record(z.string(), z.string())]),
});

// An operation that names a locale asks about that one, through a client
// bound to it. One that names none is about the whole document, so it asks
// for every locale's status; Payload ignores the parameter where a
// collection keeps a single status.
const publishedPath = (operation: UnpublishOperation): string =>
  `/api/${encodeURIComponent(operation.collection)}/${encodeURIComponent(String(operation.id))}?depth=0&select[_status]=true${operation.locale === undefined ? "&locale=all" : ""}`;

interface Published {
  // Whether the public is served the document, in any locale asked about.
  any: boolean;
  // The locales it is published in, where the collection keeps a status
  // for each and the operation named none.
  locales?: string[];
}

// The status of the document itself, which is what the public sees. A read
// that names the draft answers with the newest version, and that is a draft
// whenever someone has saved one since the document was published.
const publicStatus = async (
  context: UnpublishContext,
  operation: UnpublishOperation
): Promise<Published> => {
  const result = await payloadRest(
    context.client,
    publishedPath(operation),
    context.telemetry
  );

  const parsed = statusSchema.safeParse(result.json);

  if (result.status !== 200 || !parsed.success) {
    throw new ApplyConflictError(
      "read_failed",
      `Payload did not say whether ${unpublishTarget(operation)} is published`
    );
  }

  const status = parsed.data._status;
  const one = z.string().safeParse(status);

  if (one.success) {
    return { any: one.data === "published" };
  }

  const locales = Object.entries(status)
    .filter(([, value]) => value === "published")
    .map(([code]) => code)
    .toSorted();

  return { any: locales.length > 0, locales };
};

const unpublishable = (
  info: EditingInfo,
  operation: UnpublishOperation
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

interface Current {
  // Where the public is served it now.
  published: Published;
  // The document's own slug, where it has one.
  slug: string;
  // The newest version's `updatedAt`: what a `draft: true` read reports.
  stamp: string;
}

const slugSchema = z.string();

// The document as it stands, refused unless it is published now.
const publishedDocument = async (
  context: UnpublishContext,
  operation: UnpublishOperation
): Promise<Current> => {
  const target = unpublishTarget(operation);

  const record = await readDocument(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  assertDraftDocument(record, operation.collection);

  const stamp = requireStamp(record, target);

  const published = await publicStatus(context, operation);

  if (!published.any) {
    throw new ApplyConflictError(
      "already_draft",
      operation.locale === undefined
        ? `${target} is not published, so there is nothing to unpublish`
        : `${target} is not published in the ${operation.locale} locale, so there is nothing to unpublish there`
    );
  }

  const slug = slugSchema.safeParse(record.slug);

  return { published, slug: slug.success ? slug.data : "", stamp };
};

// As much of a path as a warning shows.
const PATH_LIMIT = 120;

// What the approver is told above the change: where the page is, and what
// happens to links to it. Whether a redirect would catch them is not said:
// which redirect a site's front end follows, and whether its destination
// can be reached, are that front end's rules, and a wrong promise here is
// worse than none.
const unpublishWarning = (
  address: DocumentAddress,
  locale: string | undefined
): string => {
  const { path } = address;

  const where =
    path === undefined || path.length > PATH_LIMIT ? "" : ` at ${path}`;

  const links = "Links to it will 404 unless a redirect covers them.";

  return locale === undefined
    ? `The public page${where} goes away as soon as you approve. ${links}`
    : `Only the ${locale} locale is unpublished; the others stay as they are. The ${locale} version of the public page${where} goes away as soon as you approve. ${links}`;
};

// What the approver reads when the collection keeps a status for each
// locale and the operation named none: the locales that go, by name.
const everyLocale = (
  operation: UnpublishOperation,
  published: Published
): Pick<OperationPreflight, "fields" | "sentence"> => {
  const status: FieldSnapshot = {
    after: "draft",
    before: "published",
    changed: true,
    path: STATUS_FIELD,
  };

  if (published.locales === undefined) {
    return { fields: [status], sentence: unpublishSentence(operation) };
  }

  return {
    fields: [
      {
        ...status,
        before: `published in ${published.locales.join(", ")}`,
        label: `${STATUS_FIELD} · every locale`,
      },
    ],
    sentence: `${unpublishSentence(operation)} in every locale`,
  };
};

const documentAddress = (
  context: UnpublishContext,
  collection: CollectionEditing,
  operation: UnpublishOperation
): Promise<DocumentAddress> =>
  collection.preview
    ? readDocumentAddress(
        context.client,
        operation.collection,
        operation.id,
        context.telemetry
      )
    : Promise.resolve({});

export const preflightUnpublish = async (
  context: UnpublishPreflightContext,
  operation: UnpublishOperation,
  index: number
): Promise<OperationPreflight> => {
  const collection = unpublishable(context.info, operation);
  const target = unpublishTarget(operation);

  const { published, slug, stamp } = await publishedDocument(
    context,
    operation
  );

  if (operation.expected_updated_at !== stamp) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${target} was last updated at ${stamp}`
    );
  }

  const address = await documentAddress(context, collection, operation);
  const previewUrl = address.url ? context.siteUrl(address.url) : "";

  const preview: OperationPreflight = {
    editUrl: context.adminUrl(operation.collection, operation.id),
    editor: "Payload admin",
    ...everyLocale(operation, published),
    modifiedGmt: stamp,
    operationIndex: index,
    slug,
    target,
    warning: unpublishWarning(address, operation.locale),
  };

  if (previewUrl) {
    preview.previewUrl = previewUrl;
  }

  return preview;
};

type LandedFacts = Pick<
  OperationReceipt,
  "details" | "updated_at" | "version_id"
>;

// The request the admin's Unpublish button sends. An operation that names a
// locale leaves the flag out, and Payload then unpublishes the locale the
// request is in.
const sendUnpublish = async (
  context: UnpublishContext,
  operation: UnpublishOperation,
  target: string
): Promise<string | undefined> => {
  const write = await payloadRest(
    context.client,
    `/api/${encodeURIComponent(operation.collection)}/${encodeURIComponent(String(operation.id))}?depth=0${operation.locale === undefined ? "&unpublishAllLocales=true" : ""}`,
    context.telemetry,
    {
      body: JSON.stringify({ [STATUS_FIELD]: "draft" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }
  );

  if (write.status === LOCKED_STATUS) {
    throw lockedError(target);
  }

  if (write.status < 200 || write.status >= 300) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  return writtenStamp(write);
};

const landedFacts = async (
  context: UnpublishContext,
  operation: UnpublishOperation,
  collection: CollectionEditing,
  stamp: string | undefined
): Promise<LandedFacts> => {
  const facts: LandedFacts = {};

  const [after, versionId, address] = await Promise.all([
    readDocument(
      context.client,
      operation.collection,
      operation.id,
      context.telemetry
    ),
    // Payload marks the newest version a draft in place, so the version
    // this write made is that one.
    writtenVersionId(
      context.client,
      operation.collection,
      { id: operation.id, stamp },
      context.telemetry
    ),
    documentAddress(context, collection, operation),
  ]);

  const updated = updatedAt(after);

  if (updated !== undefined) {
    facts.updated_at = updated;
  }

  if (versionId !== undefined) {
    facts.version_id = versionId;
  }

  const details = receiptDetails({
    preview_url: address.url ? context.siteUrl(address.url) : "",
  });

  if (details) {
    facts.details = details;
  }

  return facts;
};

export const applyUnpublish = async (
  context: UnpublishContext,
  operation: UnpublishOperation,
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

  if (snapshot.target !== unpublishTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    // Checked again at write time: the collection's drafts, this editor's
    // permissions or the document itself may have changed since the preview.
    const collection = unpublishable(
      await readEditingInfo(context.client, context.telemetry),
      operation
    );

    const { stamp } = await publishedDocument(context, operation);

    if (stamp !== snapshot.modifiedGmt) {
      throw new ApplyConflictError(
        "modified_since_preflight",
        `${snapshot.target} changed after the approval preview`
      );
    }

    const written = await sendUnpublish(context, operation, snapshot.target);
    const landed = await landedFacts(context, operation, collection, written);

    // A hook or field access can keep the document published. Read from the
    // document itself, as the public is.
    const still = await publicStatus(context, operation);

    if (still.any) {
      return {
        ...landed,
        ...outcome("failed", [], {
          code: "still_published",
          message: `Payload answered the write, but ${snapshot.target} is still published`,
        }),
      };
    }

    return { ...landed, ...outcome("changed", [STATUS_FIELD]) };
  } catch (error) {
    return failure(toReceiptError(error));
  }
};
