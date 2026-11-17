import {
  describeImage,
  extensionsFor,
  MAX_BLOB_BYTES,
  readBoundedBody,
  sniffFileType,
  StagedBlobError,
  SVG_TYPE,
  typeAllowed,
  UpstreamRequestError,
} from "@patronage/mcp-core";
import type {
  JsonObject,
  RuntimeStore,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { readEditingInfo } from "./payload-editing";
import type { UploadEditing } from "./payload-editing";
import { filenameSchema, slugSchema } from "./payload-operations";

// `payload.stageUpload`: the read-phase half of an upload. It takes a file
// from a URL on the collection's allow-list or from a small base64 string,
// checks what the bytes really are, and keeps them in the gateway under
// their SHA-256. Nothing reaches Payload here; `payload.apply` names the
// hash, and a person approves the upload with its thumbnail in front of them.

// A base64 file travels in the script itself and in the tool's arguments,
// which go into the run's durable log, so it is kept small. A script is
// bounded too (20,000 characters, about 14 KB of file), which is the limit a
// caller meets first; this one holds whatever a script is allowed to be.
// Larger files come from a URL.
export const MAX_BASE64_UPLOAD_BYTES = 1024 * 1024;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

// The longest base64 text that can hold `MAX_BASE64_UPLOAD_BYTES`.
const MAX_BASE64_LENGTH = Math.ceil(MAX_BASE64_UPLOAD_BYTES / 3) * 4;

const stageArgsSchema = z.strictObject({
  collection: slugSchema,
  source: z.union([
    z.strictObject({ url: z.string().min(1).max(2000) }),
    z.strictObject({
      base64: z.string().min(4).max(MAX_BASE64_LENGTH),
      filename: filenameSchema,
      mimeType: z.string().min(3).max(100),
    }),
  ]),
});

type AllowList = NonNullable<UploadEditing["urlAllowList"]>;

const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const refuse = (message: string): UpstreamRequestError =>
  new UpstreamRequestError(message);

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

// Payload's own allow-list pattern for a path: `**` is any path, `*` any part
// of one segment, and a trailing slash is optional.
const pathPattern = (pathname: string): RegExp =>
  new RegExp(
    `^${escapeRegExp(pathname)
      .replaceAll(String.raw`\*\*`, ".*")
      .replaceAll(String.raw`\*`, "[^/]*")
      .replace(/\/$/u, "(/)?")}$`,
    "u"
  );

/**
 * Whether a URL is one the collection takes files from: Payload's own
 * `pasteURL.allowList`, read the way Payload reads it, and HTTPS only. A URL
 * with a port or with credentials is refused unless the list names the port.
 */
export const urlAllowed = (url: URL, allowList: AllowList): boolean =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  allowList.some(
    (entry) =>
      entry.hostname === url.hostname &&
      (entry.protocol === undefined || `${entry.protocol}:` === url.protocol) &&
      (entry.port ?? "") === url.port &&
      (entry.search === undefined || entry.search === url.search) &&
      (entry.pathname === undefined ||
        pathPattern(entry.pathname).test(url.pathname))
  );

interface FetchRules {
  allowList: AllowList;
  fetcher: typeof fetch;
  maxBytes: number;
}

const fetchHop = async (
  url: URL,
  rules: FetchRules,
  redirectsLeft: number
): Promise<Uint8Array> => {
  // Checked on every hop, so an allowed host cannot hand the gateway on to
  // one that is not.
  if (!urlAllowed(url, rules.allowList)) {
    throw refuse(
      `${url.hostname} is not a place this collection takes files from`
    );
  }

  const response = await rules.fetcher(url, {
    headers: { Accept: "image/*,*/*;q=0.5" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const location = response.headers.get("Location");

  if (response.status >= 300 && response.status < 400 && location) {
    await response.body?.cancel();

    if (redirectsLeft === 0) {
      throw refuse("The file's address redirected too many times");
    }

    return await fetchHop(new URL(location, url), rules, redirectsLeft - 1);
  }

  if (response.status !== 200) {
    await response.body?.cancel();

    throw refuse(`${url.hostname} answered HTTP ${response.status}`);
  }

  try {
    return await readBoundedBody(response, {
      label: "The file",
      maxBytes: rules.maxBytes,
    });
  } catch {
    throw refuse(
      `The file is larger than the ${sizeText(rules.maxBytes)} this collection takes, or could not be read`
    );
  }
};

const fetchFile = async (
  address: string,
  rules: FetchRules
): Promise<{ bytes: Uint8Array; url: URL }> => {
  let url: URL;

  try {
    url = new URL(address);
  } catch {
    throw refuse("source.url is not a URL");
  }

  try {
    return { bytes: await fetchHop(url, rules, MAX_REDIRECTS), url };
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      throw error;
    }

    throw refuse(`The file could not be fetched from ${url.hostname}`);
  }
};

const decodeBase64 = (text: string): Uint8Array => {
  if (text.length % 4 !== 0 || !BASE64.test(text)) {
    throw refuse(
      "source.base64 is not plain base64 (no data: prefix, no line breaks)"
    );
  }

  return Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);
};

const extensionOf = (filename: string): string =>
  filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();

/** Whether a file name's extension is one its type goes by. */
export const extensionMatches = (filename: string, mimeType: string): boolean =>
  extensionsFor(mimeType).includes(extensionOf(filename));

// A name for a file fetched from a URL: the last path segment, reduced to
// plain characters, with the extension its type goes by.
const nameFromUrl = (url: URL, mimeType: string): string => {
  const [extension = "bin"] = extensionsFor(mimeType);
  let segment = "";

  try {
    segment = decodeURIComponent(
      url.pathname.split("/").findLast(Boolean) ?? ""
    );
  } catch {
    // A path that is not valid percent-encoding has no usable name.
  }

  const plain = segment
    .replaceAll(/[^A-Za-z0-9._ -]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 100);

  const stem = plain.includes(".")
    ? plain.slice(0, plain.lastIndexOf("."))
    : plain;

  const named = `${stem || "upload"}.${extension}`;

  return extensionMatches(plain, mimeType) &&
    filenameSchema.safeParse(plain).success
    ? plain
    : named;
};

/**
 * Why a collection will not take a file, or undefined when it will. Checked
 * when the file is staged, again in the approval preview, and again before
 * the write, against whatever Payload says at that moment.
 */
export const fileRefusal = (
  upload: UploadEditing,
  file: { bytes: number; mimeType: string }
): string | undefined => {
  // An SVG can carry script, so it is refused whatever the collection lists.
  if (file.mimeType === SVG_TYPE) {
    return "SVG files are not accepted";
  }

  if (!typeAllowed(file.mimeType, upload.mimeTypes)) {
    return `This collection does not take ${file.mimeType} files`;
  }

  const limit = Math.min(upload.maxFileSize ?? MAX_BLOB_BYTES, MAX_BLOB_BYTES);

  return file.bytes > limit
    ? `The file is ${sizeText(file.bytes)}; this collection takes at most ${sizeText(limit)}`
    : undefined;
};

export interface StageUploadDeps {
  client: UpstreamClient;
  executionId: string;
  // Stands in for `fetch` under test.
  fetcher?: typeof fetch;
  images: ImagesBinding | undefined;
  store: RuntimeStore;
  telemetry: UpstreamTelemetry;
}

interface Sourced {
  bytes: Uint8Array;
  // The name the caller gave, checked against the type once it is known.
  declared?: { filename: string; mimeType: string };
  source: string;
  url?: URL;
}

const readSource = async (
  source: z.infer<typeof stageArgsSchema>["source"],
  upload: UploadEditing,
  fetcher: typeof fetch
): Promise<Sourced> => {
  if ("base64" in source) {
    return {
      bytes: decodeBase64(source.base64),
      declared: { filename: source.filename, mimeType: source.mimeType },
      source: "uploaded file",
    };
  }

  if (!upload.urlAllowList) {
    throw refuse(
      "This collection takes no files by URL; send the file as base64 instead"
    );
  }

  const fetched = await fetchFile(source.url, {
    allowList: upload.urlAllowList,
    fetcher,
    maxBytes: Math.min(upload.maxFileSize ?? MAX_BLOB_BYTES, MAX_BLOB_BYTES),
  });

  return {
    bytes: fetched.bytes,
    source: fetched.url.hostname,
    url: fetched.url,
  };
};

const nameFor = (sourced: Sourced, mimeType: string): string => {
  if (sourced.declared) {
    if (sourced.declared.mimeType !== mimeType) {
      throw refuse(
        `The file is ${mimeType}, not ${sourced.declared.mimeType} as declared`
      );
    }

    if (!extensionMatches(sourced.declared.filename, mimeType)) {
      throw refuse(
        `${sourced.declared.filename} does not have the extension of a ${mimeType} file`
      );
    }

    return sourced.declared.filename;
  }

  return sourced.url ? nameFromUrl(sourced.url, mimeType) : "upload.bin";
};

/**
 * Stages one file for a later `payload.apply` in the same run and answers
 * with its `upload_ref` and what the file turned out to be.
 */
export const stageUpload = async <T>(
  deps: StageUploadDeps,
  args: T
): Promise<JsonObject> => {
  const parsed = stageArgsSchema.safeParse(args);

  if (!parsed.success) {
    throw refuse(
      "payload.stageUpload takes { collection, source: { url } } or { collection, source: { base64, filename, mimeType } }, with at most 1 MB of base64"
    );
  }

  if (!deps.store.stageBlob) {
    throw refuse("This gateway cannot stage files");
  }

  const info = await readEditingInfo(deps.client, deps.telemetry);

  const collection = info.collections.find(
    (entry) => entry.slug === parsed.data.collection
  );

  if (!collection?.upload) {
    throw refuse(
      `${parsed.data.collection} is not an upload collection this editor can read`
    );
  }

  const sourced = await readSource(
    parsed.data.source,
    collection.upload,
    deps.fetcher ?? fetch
  );

  const mimeType = sniffFileType(sourced.bytes);

  if (mimeType === undefined) {
    throw refuse("The file is not a type this gateway can upload");
  }

  const refusal = fileRefusal(collection.upload, {
    bytes: sourced.bytes.byteLength,
    mimeType,
  });

  if (refusal !== undefined) {
    throw refuse(refusal);
  }

  const filename = nameFor(sourced, mimeType);

  const image = mimeType.startsWith("image/")
    ? await describeImage(deps.images, sourced.bytes)
    : undefined;

  try {
    const blob = await deps.store.stageBlob(deps.executionId, sourced.bytes, {
      filename,
      mimeType,
      source: sourced.source,
      ...image,
    });

    // The same bytes staged a second time are the file staged first, under
    // the name it was given then. The answer describes that file, which is
    // the one `upload_ref` will upload.
    const result: JsonObject = {
      bytes: blob.bytes,
      filename: blob.filename ?? filename,
      mimeType: blob.mimeType,
      source: blob.source,
      upload_ref: `sha256:${blob.sha256}`,
    };

    if (blob.width !== undefined && blob.height !== undefined) {
      result.width = blob.width;
      result.height = blob.height;
    }

    return result;
  } catch (error) {
    if (error instanceof StagedBlobError) {
      throw refuse(error.message);
    }

    throw error;
  }
};
