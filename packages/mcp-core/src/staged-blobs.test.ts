import { describe, expect, it } from "vitest";

import {
  BLOB_CHUNK_BYTES,
  BLOB_META_PREFIX,
  deleteRunBlobs,
  pruneBlobs,
  readBlob,
  readBlobMeta,
  sha256Hex,
  stageBlob,
  StagedBlobError,
} from "./staged-blobs";
import type { BlobStorage, StagedBlob } from "./staged-blobs";

// SAFETY: a test reads back the type it stored under the same key.
const stored = <T>(value: Uint8Array | StagedBlob | undefined) =>
  value as T | undefined;

// Durable Object storage as this module uses it: a list never returns a key
// outside its prefix.
const memoryStorage = () => {
  const values = new Map<string, Uint8Array | StagedBlob>();

  const storage: BlobStorage = {
    delete: (keys) =>
      Promise.resolve(keys.filter((key) => values.delete(key)).length),
    get: <T>(key: string) => Promise.resolve(stored<T>(values.get(key))),
    list: <T>({ prefix }: { prefix: string }) => {
      const found = new Map<string, T>();

      for (const [key, value] of values) {
        const entry = stored<T>(value);

        if (key.startsWith(prefix) && entry !== undefined) {
          found.set(key, entry);
        }
      }

      return Promise.resolve(found);
    },
    put: <T>(key: string, value: T) => {
      // SAFETY: this module stores only chunks and metas.
      values.set(key, value as Uint8Array | StagedBlob);

      return Promise.resolve();
    },
  };

  return { storage, values };
};

const bytesOf = (length: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);

const FACTS = { mimeType: "image/png", source: "uploaded file" };

describe(stageBlob, () => {
  it("keeps a file in chunks under its hash and reads it back whole", async () => {
    const { storage, values } = memoryStorage();
    const bytes = bytesOf(BLOB_CHUNK_BYTES * 2 + 17);

    const blob = await stageBlob(storage, "exec_1", bytes, {
      ...FACTS,
      filename: "garden.png",
      height: 600,
      width: 800,
    });

    expect(blob).toMatchObject({
      bytes: bytes.byteLength,
      chunks: 3,
      executionId: "exec_1",
      filename: "garden.png",
      height: 600,
      mimeType: "image/png",
      sha256: await sha256Hex(bytes),
      source: "uploaded file",
      width: 800,
    });
    // Three chunks and one meta, and no value over a Durable Object's limit.
    expect(values.size).toBe(4);

    const read = await readBlob(storage, "exec_1", blob.sha256);

    expect(read?.bytes).toStrictEqual(bytes);
    expect(read?.blob).toStrictEqual(blob);
  });

  it("keeps the same bytes once per run", async () => {
    const { storage, values } = memoryStorage();
    const bytes = bytesOf(100);
    const first = await stageBlob(storage, "exec_1", bytes, FACTS);
    const second = await stageBlob(storage, "exec_1", bytes, FACTS);

    expect(second).toStrictEqual(first);
    expect(values.size).toBe(2);
  });

  it("refuses an empty file and one over the per-file limit", async () => {
    const { storage, values } = memoryStorage();

    await expect(
      stageBlob(storage, "exec_1", new Uint8Array(), FACTS)
    ).rejects.toMatchObject({ code: "blob_empty" });
    await expect(
      stageBlob(storage, "exec_1", bytesOf(1025), FACTS, {
        maxBlobBytes: 1024,
      })
    ).rejects.toBeInstanceOf(StagedBlobError);
    expect(values.size).toBe(0);
  });

  it("refuses a file that takes the run over its limit", async () => {
    const { storage } = memoryStorage();
    const limits = { maxRunBlobBytes: 1500 };

    await stageBlob(storage, "exec_1", bytesOf(1000, 1), FACTS, limits);

    await expect(
      stageBlob(storage, "exec_1", bytesOf(1000, 2), FACTS, limits)
    ).rejects.toMatchObject({ code: "run_blob_limit" });
    // Another run has its own allowance.
    await expect(
      stageBlob(storage, "exec_2", bytesOf(1000, 2), FACTS, limits)
    ).resolves.toMatchObject({ executionId: "exec_2" });
  });

  it("never raises a limit above the package's own", async () => {
    const { storage } = memoryStorage();

    await expect(
      stageBlob(storage, "exec_1", bytesOf(11 * 1024 * 1024), FACTS, {
        maxBlobBytes: 64 * 1024 * 1024,
      })
    ).rejects.toMatchObject({ code: "blob_too_large" });
  });

  it("keeps a thumbnail only when it is the one kind the surfaces show", async () => {
    const { storage } = memoryStorage();

    const kept = await stageBlob(storage, "exec_1", bytesOf(10, 1), {
      ...FACTS,
      thumbnail: "data:image/webp;base64,AAAA",
    });

    const dropped = await stageBlob(storage, "exec_1", bytesOf(10, 2), {
      ...FACTS,
      thumbnail: "data:image/svg+xml;base64,AAAA",
    });

    expect(kept.thumbnail).toBe("data:image/webp;base64,AAAA");
    expect(dropped.thumbnail).toBeUndefined();
  });
});

describe(readBlob, () => {
  it("is scoped to the run that staged the file", async () => {
    const { storage } = memoryStorage();
    const blob = await stageBlob(storage, "exec_1", bytesOf(64), FACTS);

    await expect(
      readBlob(storage, "exec_2", blob.sha256)
    ).resolves.toBeUndefined();
    await expect(
      readBlobMeta(storage, "exec_2", blob.sha256)
    ).resolves.toBeUndefined();
    await expect(
      readBlobMeta(storage, "exec_1", blob.sha256)
    ).resolves.toStrictEqual(blob);
  });

  it("refuses a name that is not a SHA-256", async () => {
    const { storage } = memoryStorage();

    await stageBlob(storage, "exec_1", bytesOf(64), FACTS);

    await expect(
      readBlob(storage, "exec_1", "exec_1:other")
    ).resolves.toBeUndefined();
  });

  it("returns nothing when the stored bytes no longer match their hash", async () => {
    const { storage, values } = memoryStorage();
    const blob = await stageBlob(storage, "exec_1", bytesOf(64), FACTS);

    values.set(`blob:exec_1:${blob.sha256}:0`, bytesOf(64, 9));

    await expect(
      readBlob(storage, "exec_1", blob.sha256)
    ).resolves.toBeUndefined();

    values.delete(`blob:exec_1:${blob.sha256}:0`);

    await expect(
      readBlob(storage, "exec_1", blob.sha256)
    ).resolves.toBeUndefined();
  });
});

describe("cleanup", () => {
  it("drops one run's files and leaves another's", async () => {
    const { storage, values } = memoryStorage();

    await stageBlob(storage, "exec_1", bytesOf(BLOB_CHUNK_BYTES + 1), FACTS);
    await stageBlob(storage, "exec_1", bytesOf(10, 3), FACTS);
    const other = await stageBlob(storage, "exec_10", bytesOf(10, 4), FACTS);

    await deleteRunBlobs(storage, "exec_1");

    expect([...values.keys()].toSorted()).toStrictEqual([
      `blob:exec_10:${other.sha256}:0`,
      `${BLOB_META_PREFIX}exec_10:${other.sha256}`,
    ]);
  });

  it("prunes files staged before the cutoff, whatever their run", async () => {
    const { storage, values } = memoryStorage();
    const old = await stageBlob(storage, "exec_1", bytesOf(10, 1), FACTS);
    const fresh = await stageBlob(storage, "exec_2", bytesOf(10, 2), FACTS);
    const key = `${BLOB_META_PREFIX}exec_1:${old.sha256}`;
    const aged: StagedBlob = { ...old, stagedAt: old.stagedAt - 10_000 };

    values.set(key, aged);

    await expect(pruneBlobs(storage, old.stagedAt - 5000)).resolves.toBe(1);
    await expect(
      readBlob(storage, "exec_1", old.sha256)
    ).resolves.toBeUndefined();
    await expect(
      readBlob(storage, "exec_2", fresh.sha256)
    ).resolves.toBeDefined();
  });
});
