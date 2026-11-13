import { ApplyConflictError, receiptDetails } from "@patronage/mcp-core";
import type {
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

const statusSchema = z.object({ _status: z.string() });

const publishedPath = (operation: UnpublishOperation): string =>
  `/api/${encodeURIComponent(operation.collection)}/${encodeURIComponent(String(operation.id))}?depth=0&select[_status]=true`;

// The status of the document itself, which is what the public sees. A read
// that names the draft answers with the newest version, and that is a draft
// whenever someone has saved one since the document was published.
const publicStatus = async (
  context: UnpublishContext,
  operation: UnpublishOperation
): Promise<string> => {
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

  return parsed.data._status;
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

  if ((await publicStatus(context, operation)) !== "published") {
    throw new ApplyConflictError(
      "already_draft",
      `${target} is not published, so there is nothing to unpublish`
    );
  }

  const slug = slugSchema.safeParse(record.slug);

  return { slug: slug.success ? slug.data : "", stamp };
};

const redirectsSchema = z.object({ docs: z.array(z.unknown()) });

// Whether an editor-managed redirect leaves the document's public path
// (`@payloadcms/plugin-redirects` keeps them in `redirects`, by `from`).
// Undefined where the site has no such collection or it cannot be read.
const redirectFrom = async (
  context: UnpublishPreflightContext,
  path: string
): Promise<boolean | undefined> => {
  if (!context.info.collections.some((entry) => entry.slug === "redirects")) {
    return undefined;
  }

  try {
    const result = await payloadRest(
      context.client,
      `/api/redirects?where[from][equals]=${encodeURIComponent(path)}&limit=1&depth=0`,
      context.telemetry
    );

    const parsed = redirectsSchema.safeParse(result.json);

    return result.status === 200 && parsed.success
      ? parsed.data.docs.length > 0
      : undefined;
  } catch {
    return undefined;
  }
};

// As much of a path as a warning shows.
const PATH_LIMIT = 120;

const GENERIC_WARNING =
  "The public page goes away as soon as you approve. Links to it will 404 unless a redirect exists.";

// What the approver is told above the change: where the page is, and what
// happens to links to it.
const unpublishWarning = async (
  context: UnpublishPreflightContext,
  address: DocumentAddress
): Promise<string> => {
  const { path } = address;

  if (path === undefined || path.length > PATH_LIMIT) {
    return GENERIC_WARNING;
  }

  const redirected = await redirectFrom(context, path);

  if (redirected === undefined) {
    return `The public page at ${path} goes away as soon as you approve. Links to it will 404 unless a redirect exists.`;
  }

  return redirected
    ? `The public page at ${path} goes away as soon as you approve. A redirect from that path exists, so links to it will follow the redirect.`
    : `The public page at ${path} goes away as soon as you approve. No redirect from that path exists, so links to it will 404.`;
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
  const { slug, stamp } = await publishedDocument(context, operation);

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
    fields: [
      {
        after: "draft",
        before: "published",
        changed: true,
        path: STATUS_FIELD,
      },
    ],
    modifiedGmt: stamp,
    operationIndex: index,
    sentence: unpublishSentence(operation),
    slug,
    target,
    warning: await unpublishWarning(context, address),
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

// The request the admin's Unpublish button sends.
const sendUnpublish = async (
  context: UnpublishContext,
  operation: UnpublishOperation,
  target: string
): Promise<string | undefined> => {
  const write = await payloadRest(
    context.client,
    `/api/${encodeURIComponent(operation.collection)}/${encodeURIComponent(String(operation.id))}?depth=0&unpublishAllLocales=true`,
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
    if ((await publicStatus(context, operation)) === "published") {
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
