import { isThumbnailSrc } from "./apply";

// Files a run stages for a later `apply`, kept in the gateway Durable Object's
// own storage. The bytes of an upload must not travel in `apply`'s arguments:
// those go into the codemode durable log, where one value holds at most 2 MB.
// So a read-phase tool stages the file here, and `apply` names it by hash.
//
// This module is package-free like `run.ts`: it sees storage through
// `BlobStorage`, so every rule below is testable under node vitest.

// One file, and everything one run may hold at once. A deployment may lower
// either; neither may exceed what a Durable Object can hold in memory while it
// reassembles a file.
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_RUN_BLOB_BYTES = 25 * 1024 * 1024;

// One Durable Object value holds at most 2 MB, so a file is stored in chunks
// of half that.
export const BLOB_CHUNK_BYTES = 1024 * 1024;

// How many keys one Durable Object `delete` call takes.
const DELETE_BATCH = 128;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

// Meta and chunks live under different prefixes, so listing a run's files, or
// every file for the daily prune, never loads a byte of any of them.
export const BLOB_META_PREFIX = "blobmeta:";
const BLOB_CHUNK_PREFIX = "blob:";

const metaPrefix = (executionId: string): string =>
  `${BLOB_META_PREFIX}${executionId}:`;

const metaKey = (executionId: string, sha256: string): string =>
  `${metaPrefix(executionId)}${sha256}`;

const chunkKey = (executionId: string, sha256: string, index: number): string =>
  `${BLOB_CHUNK_PREFIX}${executionId}:${sha256}:${index}`;

// What the tool that staged a file knows about it. The store adds the size,
// the hash and the time itself, from the bytes it was handed.
export interface StagedBlobFacts {
  filename?: string;
  height?: number;
  // The file's type as read from its bytes, never as a caller declared it.
  mimeType: string;
  // Where the bytes came from, for the approval preview: a host name, or a
  // phrase such as "uploaded file".
  source: string;
  // A `data:image/webp` thumbnail, kept only when `isThumbnailSrc` accepts it.
  thumbnail?: string;
  width?: number;
}

export interface StagedBlob extends StagedBlobFacts {
  bytes: number;
  chunks: number;
  executionId: string;
  sha256: string;
  stagedAt: number;
}

export class StagedBlobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "StagedBlobError";
  }
}

// The slice of Durable Object storage this module uses.
export interface BlobStorage {
  delete: (keys: string[]) => Promise<number>;
  get: <T>(key: string) => Promise<T | undefined>;
  list: <T>(options: { prefix: string }) => Promise<Map<string, T>>;
  put: <T>(key: string, value: T) => Promise<void>;
}

export interface BlobLimits {
  maxBlobBytes?: number;
  maxRunBlobBytes?: number;
}

// What storage holds for a file. `pending` marks one whose chunks are still
// being written: it already counts against the run's limit and cleanup finds
// it, but nothing can read it.
type StoredBlob = StagedBlob & { pending?: true };

// One staging at a time per run, so two files staged together cannot both
// pass the run's limit before either is on record. A Durable Object is one
// instance, so a queue in memory is enough; it is kept per storage object.
const queues = new WeakMap<BlobStorage, Map<string, Promise<void>>>();

const settled = async <T>(work: Promise<T>): Promise<void> => {
  try {
    await work;
  } catch {
    // The caller that started the work hears its failure; the queue only
    // needs to know it is over.
  }
};

const inTurn = async <T>(
  storage: BlobStorage,
  executionId: string,
  task: () => Promise<T>
): Promise<T> => {
  const queue = queues.get(storage) ?? new Map<string, Promise<void>>();

  queues.set(storage, queue);

  const before = queue.get(executionId);

  const work = (async () => {
    await before;

    return await task();
  })();

  const turn = settled(work);

  queue.set(executionId, turn);

  try {
    return await work;
  } finally {
    if (queue.get(executionId) === turn) {
      queue.delete(executionId);
    }
  }
};

const megabytes = (bytes: number): string =>
  `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const listMetas = async (
  storage: BlobStorage,
  prefix: string
): Promise<StoredBlob[]> => {
  const stored = await storage.list<StoredBlob>({ prefix });

  return [...stored.values()];
};

const deleteKeys = async (
  storage: BlobStorage,
  keys: string[]
): Promise<void> => {
  for (let start = 0; start < keys.length; start += DELETE_BATCH) {
    // One batch at a time: a Durable Object applies its writes in order.
    // oxlint-disable-next-line no-await-in-loop
    await storage.delete(keys.slice(start, start + DELETE_BATCH));
  }
};

const blobKeys = (blob: StagedBlob): string[] => [
  // The meta goes first, so a file half deleted is one nobody can read.
  metaKey(blob.executionId, blob.sha256),
  ...Array.from({ length: blob.chunks }, (_, index) =>
    chunkKey(blob.executionId, blob.sha256, index)
  ),
];

const describeBlob = (
  executionId: string,
  sha256: string,
  bytes: Uint8Array,
  facts: StagedBlobFacts
): StagedBlob => {
  const blob: StagedBlob = {
    bytes: bytes.byteLength,
    chunks: Math.ceil(bytes.byteLength / BLOB_CHUNK_BYTES),
    executionId,
    mimeType: facts.mimeType,
    sha256,
    source: facts.source,
    stagedAt: Date.now(),
  };

  if (facts.filename !== undefined) {
    blob.filename = facts.filename;
  }

  if (facts.width !== undefined && facts.height !== undefined) {
    blob.width = facts.width;
    blob.height = facts.height;
  }

  if (facts.thumbnail !== undefined && isThumbnailSrc(facts.thumbnail)) {
    blob.thumbnail = facts.thumbnail;
  }

  return blob;
};

const writeBlob = async (
  storage: BlobStorage,
  blob: StagedBlob,
  bytes: Uint8Array
): Promise<void> => {
  const key = metaKey(blob.executionId, blob.sha256);
  const pending: StoredBlob = { ...blob, pending: true };

  // On record before its first chunk: the file holds its share of the run's
  // limit from here, and cleanup can find every chunk it may come to have.
  await storage.put(key, pending);

  try {
    for (let index = 0; index < blob.chunks; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, like every write.
      await storage.put(
        chunkKey(blob.executionId, blob.sha256, index),
        bytes.slice(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES)
      );
    }

    // Readable only now: a meta without `pending` means every chunk is there.
    await storage.put(key, blob);
  } catch (error) {
    try {
      await deleteKeys(storage, blobKeys(blob));
    } catch {
      // The pending meta stays, so the run's cleanup or the prune takes it.
    }

    throw error;
  }
};

/**
 * Keeps one file for one run and returns what was kept. Staging the same
 * bytes twice in a run keeps them once.
 */
export const stageBlob = async (
  storage: BlobStorage,
  executionId: string,
  bytes: Uint8Array,
  facts: StagedBlobFacts,
  limits: BlobLimits = {}
): Promise<StagedBlob> => {
  const maxBlob = Math.min(
    limits.maxBlobBytes ?? MAX_BLOB_BYTES,
    MAX_BLOB_BYTES
  );

  const maxRun = Math.min(
    limits.maxRunBlobBytes ?? MAX_RUN_BLOB_BYTES,
    MAX_RUN_BLOB_BYTES
  );

  if (bytes.byteLength === 0) {
    throw new StagedBlobError("blob_empty", "The file is empty");
  }

  if (bytes.byteLength > maxBlob) {
    throw new StagedBlobError(
      "blob_too_large",
      `The file is ${megabytes(bytes.byteLength)}; one file may be at most ${megabytes(maxBlob)}`
    );
  }

  const sha256 = await sha256Hex(bytes);

  return await inTurn(storage, executionId, async () => {
    const staged = await listMetas(storage, metaPrefix(executionId));
    const existing = staged.find((blob) => blob.sha256 === sha256);

    if (existing && !existing.pending) {
      return existing;
    }

    // A file left pending by a write that failed is written again in place,
    // so it is not counted twice.
    let held = 0;

    for (const blob of staged) {
      held += blob.sha256 === sha256 ? 0 : blob.bytes;
    }

    if (held + bytes.byteLength > maxRun) {
      throw new StagedBlobError(
        "run_blob_limit",
        `This run already holds ${megabytes(held)} of files; one run may hold at most ${megabytes(maxRun)}`
      );
    }

    const blob = describeBlob(executionId, sha256, bytes, facts);

    await writeBlob(storage, blob, bytes);

    return blob;
  });
};

/** What a run staged under one hash, without its bytes. */
export const readBlobMeta = async (
  storage: BlobStorage,
  executionId: string,
  sha256: string
): Promise<StagedBlob | undefined> => {
  if (!SHA256_HEX.test(sha256)) {
    return undefined;
  }

  const blob = await storage.get<StoredBlob>(metaKey(executionId, sha256));

  // A file still being written, or left half written, is not there yet.
  return blob && !blob.pending ? blob : undefined;
};

/**
 * The bytes a run staged under one hash. Only that run can read them: the
 * execution id is part of every key. Bytes that no longer match their hash
 * are never returned.
 */
export const readBlob = async (
  storage: BlobStorage,
  executionId: string,
  sha256: string
): Promise<{ blob: StagedBlob; bytes: Uint8Array } | undefined> => {
  const blob = await readBlobMeta(storage, executionId, sha256);

  if (!blob) {
    return undefined;
  }

  const bytes = new Uint8Array(blob.bytes);
  let offset = 0;

  for (let index = 0; index < blob.chunks; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk in memory at a time.
    const chunk = await storage.get<Uint8Array>(
      chunkKey(executionId, sha256, index)
    );

    if (!chunk || offset + chunk.byteLength > blob.bytes) {
      return undefined;
    }

    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (offset !== blob.bytes || (await sha256Hex(bytes)) !== sha256) {
    return undefined;
  }

  return { blob, bytes };
};

/** Drops every file one run staged, once nothing can apply them any more. */
export const deleteRunBlobs = async (
  storage: BlobStorage,
  executionId: string
): Promise<void> => {
  const staged = await listMetas(storage, metaPrefix(executionId));

  await deleteKeys(
    storage,
    staged.flatMap((blob) => blobKeys(blob))
  );
};

/**
 * Drops files staged before `cutoff` whose run can no longer use them. A run
 * that ended cleans up after itself; this is for one that never did. A run
 * `isLive` vouches for keeps its files however old they are: it may pause
 * again and again, each time on a write that names a file staged at its
 * start.
 */
export const pruneBlobs = async (
  storage: BlobStorage,
  cutoff: number,
  isLive: (executionId: string) => Promise<boolean> = () =>
    Promise.resolve(false)
): Promise<number> => {
  const staged = await listMetas(storage, BLOB_META_PREFIX);
  const old = staged.filter((blob) => blob.stagedAt < cutoff);
  const runs = [...new Set(old.map((blob) => blob.executionId))];

  const checked = await Promise.all(
    runs.map(async (id) => ((await isLive(id)) ? [id] : []))
  );

  const live = new Set(checked.flat());
  const stale = old.filter((blob) => !live.has(blob.executionId));

  await deleteKeys(
    storage,
    stale.flatMap((blob) => blobKeys(blob))
  );

  return stale.length;
};
