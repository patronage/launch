import {
  ApplyConflictError,
  describeImage,
  MAX_BLOB_BYTES,
  previewValue,
  receiptDetails,
  sha256Hex,
  sniffFileType,
} from "@patronage/mcp-core";
import type {
  FieldSnapshot,
  JsonObject,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  RuntimeStore,
  SnapshotImage,
  StagedBlob,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadErrorMessage, payloadFile, payloadRest } from "./payload";
import {
  classifyReadback,
  CONFLICT_CODES,
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
import { readEditingInfo } from "./payload-editing";
import type {
  CollectionEditing,
  EditingInfo,
  UploadEditing,
} from "./payload-editing";
import { uploadSha256, uploadTarget } from "./payload-operations";
import type { UploadOperation } from "./payload-operations";
import { fieldSnapshot } from "./payload-relations";
import type { TitleLookup } from "./payload-relations";
import { extensionMatches, fileRefusal } from "./payload-upload";

// The two upload kinds of `payload.apply`: a new file in an upload
// collection, and a new file for a document that has one already. The bytes
// were staged earlier in the run by `payload.stageUpload`; here they are
// shown to the approver and, once approved, sent to Payload's own upload
// route as that person, so Payload's validation, hooks and storage all run.

// The row a file's change is shown and reported under.
export const FILE_PATH = "file";

const stringSchema = z.string();
const numberSchema = z.number();
const documentIdSchema = z.union([z.number(), z.string()]);
const writtenSchema = z.object({ doc: z.object({ id: documentIdSchema }) });

/** Where an upload's staged file is read from, and what draws its picture. */
export interface UploadFiles {
  executionId: string;
  images: ImagesBinding | undefined;
  store: RuntimeStore;
}

export interface UploadPreflightContext {
  adminUrl: PayloadAdminUrl;
  client: UpstreamClient;
  files?: UploadFiles | undefined;
  info: EditingInfo;
  telemetry: UpstreamTelemetry;
  titles: TitleLookup;
}

export interface UploadApplyContext {
  client: UpstreamClient;
  files?: UploadFiles | undefined;
  siteUrl: PayloadSiteUrl;
  telemetry: UpstreamTelemetry;
}

type UploadCollection = CollectionEditing & { upload: UploadEditing };

const isUploadCollection = (
  collection: CollectionEditing
): collection is UploadCollection => collection.upload !== undefined;

const assertUploadable = (
  info: EditingInfo,
  operation: UploadOperation
): UploadCollection => {
  const collection = info.collections.find(
    (entry) => entry.slug === operation.collection
  );

  if (!collection) {
    throw new ApplyConflictError(
      "unknown_collection",
      `${operation.collection} is not a collection this editor can read`
    );
  }

  if (!isUploadCollection(collection)) {
    throw new ApplyConflictError(
      "not_an_upload_collection",
      `${operation.collection} does not hold files`
    );
  }

  const creates = operation.kind === "upload_media";

  if (!(creates ? collection.canCreate : collection.canUpdate)) {
    throw new ApplyConflictError(
      "not_permitted",
      `This editor may not ${creates ? "upload to" : "update"} ${operation.collection}`
    );
  }

  return collection;
};

const notStaged = (): ApplyConflictError =>
  new ApplyConflictError(
    "upload_not_staged",
    "No file with this upload_ref was staged in this run; stage it with payload.stageUpload before payload.apply"
  );

// The name Payload is asked to store the file under: the operation's own, or
// the one the file was staged with.
const storedName = (operation: UploadOperation, blob: StagedBlob): string => {
  const filename = operation.filename ?? blob.filename;

  if (filename === undefined || !extensionMatches(filename, blob.mimeType)) {
    throw new ApplyConflictError(
      "filename_mismatch",
      `${filename ?? "The file"} does not have the extension of a ${blob.mimeType} file`
    );
  }

  return filename;
};

// Checked in the preview and again before the write, against what Payload
// says the collection takes at that moment.
const assertAccepted = (
  collection: UploadCollection,
  blob: StagedBlob
): void => {
  const refusal = fileRefusal(collection.upload, {
    bytes: blob.bytes,
    mimeType: blob.mimeType,
  });

  if (refusal !== undefined) {
    throw new ApplyConflictError("file_not_accepted", refusal);
  }
};

const stagedImage = (blob: StagedBlob): SnapshotImage => ({
  bytes: blob.bytes,
  height: blob.height ?? 0,
  mimeType: blob.mimeType,
  sha256: blob.sha256,
  src: blob.thumbnail ?? "",
  width: blob.width ?? 0,
});

const numberOf = (record: JsonObject, key: string): number => {
  const value = numberSchema.safeParse(record[key]);

  return value.success ? value.data : 0;
};

const textOf = (record: JsonObject, key: string): string => {
  const value = stringSchema.safeParse(record[key]);

  return value.success ? value.data : "";
};

// The file a document holds now, for the "before" side of a replacement.
// Read as the approver. A file that cannot be read still shows the facts
// Payload keeps about it, without a picture or a hash.
const currentImage = async (
  context: UploadPreflightContext,
  record: JsonObject
): Promise<SnapshotImage> => {
  const image: SnapshotImage = {
    bytes: numberOf(record, "filesize"),
    height: numberOf(record, "height"),
    mimeType: textOf(record, "mimeType"),
    sha256: "",
    src: "",
    width: numberOf(record, "width"),
  };

  const link = textOf(record, "url");

  if (!link) {
    return image;
  }

  try {
    const file = await payloadFile(
      context.client,
      link,
      context.telemetry,
      MAX_BLOB_BYTES
    );

    if (!file.bytes) {
      return image;
    }

    image.bytes = file.bytes.byteLength;
    image.sha256 = await sha256Hex(file.bytes);
    image.mimeType = sniffFileType(file.bytes) ?? image.mimeType;

    const facts = image.mimeType.startsWith("image/")
      ? await describeImage(context.files?.images, file.bytes)
      : undefined;

    if (facts) {
      image.height = facts.height;
      image.width = facts.width;
      image.src = facts.thumbnail ?? "";
    }
  } catch {
    // The preview goes on with what Payload's own record says.
  }

  return image;
};

const readStaged = async (
  files: UploadFiles | undefined,
  operation: UploadOperation
): Promise<StagedBlob> => {
  const blob = await files?.store.readBlobMeta?.(
    files.executionId,
    uploadSha256(operation)
  );

  if (!blob) {
    throw notStaged();
  }

  return blob;
};

const REPLACE_WARNING_KEPT =
  "Replacing a file changes it at once everywhere it is used; there is no draft of a file. The file there now is kept as an earlier version of this document.";

const REPLACE_WARNING_GONE =
  "Replacing a file changes it at once everywhere it is used; there is no draft of a file, and this collection keeps no earlier versions, so the file there now is deleted.";

interface CurrentUpload {
  image?: SnapshotImage;
  record: JsonObject;
  stamp: string;
}

const currentUpload = async (
  context: UploadPreflightContext,
  operation: UploadOperation
): Promise<CurrentUpload> => {
  if (operation.kind === "upload_media") {
    return { record: {}, stamp: "" };
  }

  const record = await readDocument(
    context.client,
    operation.collection,
    operation.id,
    context.telemetry
  );

  const stamp = updatedAt(record);

  if (stamp === undefined) {
    throw new ApplyConflictError(
      "unreadable_updated_at",
      `Payload did not report when ${uploadTarget(operation)} was last updated`
    );
  }

  if (operation.expected_updated_at !== stamp) {
    throw new ApplyConflictError(
      "stale_expected_updated_at",
      `${uploadTarget(operation)} was last updated at ${stamp}`
    );
  }

  return { image: await currentImage(context, record), record, stamp };
};

const fileSnapshot = (
  blob: StagedBlob,
  filename: string,
  current: CurrentUpload
): FieldSnapshot => {
  const snapshot: FieldSnapshot = {
    after: previewValue(`${filename}, from ${blob.source}`),
    afterImage: stagedImage(blob),
    before: current.image
      ? previewValue(textOf(current.record, "filename"))
      : "",
    // The same bytes under the same name is no change; without a hash of
    // the file there now, a replacement counts as one.
    changed:
      current.image?.sha256 !== blob.sha256 ||
      textOf(current.record, "filename") !== filename,
    path: FILE_PATH,
  };

  if (current.image) {
    snapshot.beforeImage = current.image;
  }

  return snapshot;
};

export const preflightUpload = async (
  context: UploadPreflightContext,
  operation: UploadOperation,
  index: number
): Promise<OperationPreflight> => {
  const collection = assertUploadable(context.info, operation);
  const blob = await readStaged(context.files, operation);

  assertAccepted(collection, blob);

  const filename = storedName(operation, blob);
  const current = await currentUpload(context, operation);
  const fields = operation.fields ?? {};

  const rows = await Promise.all(
    Object.keys(fields)
      .toSorted()
      .map((path) =>
        fieldSnapshot(context.titles, collection.relationFields, path, {
          after: fields[path],
          before: current.record[path],
        })
      )
  );

  const preview: OperationPreflight = {
    editUrl:
      operation.kind === "upload_media"
        ? ""
        : context.adminUrl(operation.collection, operation.id),
    editor: "Payload admin",
    fields: [fileSnapshot(blob, filename, current), ...rows],
    modifiedGmt: current.stamp,
    operationIndex: index,
    sentence:
      operation.kind === "upload_media"
        ? `Upload ${filename} to ${operation.collection}`
        : `Replace the file of ${operation.collection} ${operation.id} with ${filename}`,
    slug: "",
    target: uploadTarget(operation),
  };

  if (operation.kind === "replace_media_file") {
    preview.warning = collection.upload.versions
      ? REPLACE_WARNING_KEPT
      : REPLACE_WARNING_GONE;
  }

  return preview;
};

class UploadedReadbackError extends Error {
  readonly receipt: ReceiptError;
  readonly target: string;

  constructor(target: string, receipt: ReceiptError) {
    super(receipt.message);
    this.name = "UploadedReadbackError";
    this.receipt = receipt;
    this.target = target;
  }
}

interface SentUpload {
  after: JsonObject;
  before: JsonObject;
  id: number | string;
  stamp?: string | undefined;
  target: string;
}

interface UploadBody {
  bytes: Uint8Array;
  fields: JsonObject;
  filename: string;
  mimeType: string;
}

// Payload's upload route takes the file and the document's other fields
// together: `file`, and the fields as JSON under `_payload`.
const uploadForm = (body: UploadBody): FormData => {
  const form = new FormData();

  form.set(
    "file",
    new File([body.bytes], body.filename, { type: body.mimeType })
  );

  form.set("_payload", JSON.stringify(body.fields));

  return form;
};

const sendUpload = async (
  context: UploadApplyContext,
  operation: UploadOperation,
  snapshot: OperationPreflight,
  body: UploadBody
): Promise<SentUpload> => {
  const { client, telemetry } = context;
  const collection = encodeURIComponent(operation.collection);
  let before: JsonObject = {};
  let path = `/api/${collection}?depth=0`;

  if (operation.kind === "replace_media_file") {
    before = await readDocument(
      client,
      operation.collection,
      operation.id,
      telemetry
    );

    if (updatedAt(before) !== snapshot.modifiedGmt) {
      throw new ApplyConflictError(
        "modified_since_preflight",
        `${snapshot.target} changed after the approval preview`
      );
    }

    path = `/api/${collection}/${encodeURIComponent(String(operation.id))}?depth=0`;
  }

  const write = await payloadRest(client, path, telemetry, {
    body: uploadForm(body),
    method: operation.kind === "upload_media" ? "POST" : "PATCH",
  });

  if (write.status === LOCKED_STATUS) {
    throw lockedError(snapshot.target);
  }

  const written = writtenSchema.safeParse(write.json);

  if (write.status < 200 || write.status >= 300 || !written.success) {
    throw new ApplyConflictError("write_failed", payloadErrorMessage(write));
  }

  const { id } = written.data.doc;
  const target = `${operation.collection}/${id}`;

  try {
    return {
      after: await readDocument(client, operation.collection, id, telemetry),
      before,
      id,
      stamp: writtenStamp(write),
      target,
    };
  } catch (error) {
    // The file is in Payload now: the receipt must say so, so nobody
    // uploads it a second time thinking the first attempt failed.
    throw new UploadedReadbackError(target, toReceiptError(error));
  }
};

// The file as Payload stored it. A different name (Payload adds a number to
// a name already taken) or a different size (a collection that converts its
// images) is Payload rewriting what it was sent, not a miss.
const fileNormalized = (after: JsonObject, body: UploadBody): boolean =>
  textOf(after, "filename") !== body.filename ||
  numberOf(after, "filesize") !== body.bytes.byteLength ||
  textOf(after, "mimeType") !== body.mimeType;

const landedReceipt = async (
  context: UploadApplyContext,
  operation: UploadOperation,
  snapshot: OperationPreflight,
  sent: SentUpload,
  body: UploadBody
): Promise<OperationReceipt> => {
  const readback = classifyReadback(body.fields, sent.before, sent.after);
  const link = textOf(sent.after, "url");

  const receipt: OperationReceipt = {
    changed_paths: [FILE_PATH, ...readback.changed],
    kind: operation.kind,
    normalized_paths: fileNormalized(sent.after, body)
      ? [FILE_PATH, ...readback.normalized]
      : readback.normalized,
    operation_index: snapshot.operationIndex,
    status: "changed",
    target: sent.target,
  };

  const stamp = updatedAt(sent.after);

  if (stamp !== undefined) {
    receipt.updated_at = stamp;
  }

  const versionId = await writtenVersionId(
    context.client,
    operation.collection,
    sent,
    context.telemetry
  );

  if (versionId !== undefined) {
    receipt.version_id = versionId;
  }

  const details = receiptDetails({
    filename: textOf(sent.after, "filename"),
    id: operation.kind === "upload_media" ? sent.id : undefined,
    url: context.siteUrl(link) || link,
  });

  if (details) {
    receipt.details = details;
  }

  if (readback.missed.length > 0) {
    receipt.error = {
      code: "readback_mismatch",
      message: missedPathsMessage(readback.missed),
    };

    receipt.status = "failed";
  }

  return receipt;
};

export const applyUpload = async (
  context: UploadApplyContext,
  operation: UploadOperation,
  snapshot: OperationPreflight
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
    status: CONFLICT_CODES.has(error.code) ? "conflict" : "failed",
    target,
  });

  if (snapshot.target !== uploadTarget(operation)) {
    return failure({
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  try {
    // Checked again at write time: what the collection takes or this
    // editor's permissions may have changed since the preview.
    const collection = assertUploadable(
      await readEditingInfo(context.client, context.telemetry),
      operation
    );

    const staged = await context.files?.store.readBlob?.(
      context.files.executionId,
      uploadSha256(operation)
    );

    if (!staged) {
      throw notStaged();
    }

    assertAccepted(collection, staged.blob);

    const body: UploadBody = {
      bytes: staged.bytes,
      fields: operation.fields ?? {},
      filename: storedName(operation, staged.blob),
      mimeType: staged.blob.mimeType,
    };

    const sent = await sendUpload(context, operation, snapshot, body);

    return await landedReceipt(context, operation, snapshot, sent, body);
  } catch (error) {
    if (error instanceof UploadedReadbackError) {
      return failure(
        {
          code: "uploaded_readback_failed",
          message: `${error.target} was saved, but reading it back failed: ${error.receipt.message}`,
        },
        error.target
      );
    }

    return failure(toReceiptError(error));
  }
};
