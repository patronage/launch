import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { timeUpstream, withDataCacheLog, withRequestLog } from "./worker.ts";

const pending: Promise<unknown>[] = [];

const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
};

// Wide events and single lines alike; only the fields these tests read.
const lineSchema = z
  .object({
    event: z.string().optional(),
    method: z.string().optional(),
    requestId: z.string().optional(),
  })
  .loose();

type Line = z.infer<typeof lineSchema>;

/** Every object the logger printed. */
const captureLines = (): Line[] => {
  const lines: Line[] = [];

  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      for (const arg of args) {
        const parsed = lineSchema.safeParse(arg);

        if (parsed.success) {
          lines.push(parsed.data);
        }
      }
    });
  }

  return lines;
};

/** The request's wide event: the line with a method. */
const wideEvent = (lines: Line[]): Line | undefined =>
  lines.find((line) => line.method !== undefined);

interface CacheValue {
  kind: string;
  data?: { body: string };
}

interface StoredValue {
  cacheState?: string;
  value: CacheValue;
}

interface ReadContext {
  kind: string;
}

const fetchValue = (body: string): CacheValue => ({
  data: { body },
  kind: "FETCH",
});

const fetchRead: ReadContext = { kind: "FETCH" };

// Stands in for a framework cache handler: a class, so methods rely on `this`.
class MemoryHandler {
  readonly entries = new Map<string, StoredValue>();
  failReads = false;
  failWrites = false;

  async get(key: string, _read?: ReadContext): Promise<StoredValue | null> {
    await delay(0);

    if (this.failReads) {
      throw new Error("KV GET failed for some-key");
    }

    return this.entries.get(key) ?? null;
  }

  // KV writes settle after the response, in waitUntil.
  async set(key: string, value: CacheValue): Promise<void> {
    await delay(5);

    if (this.failWrites) {
      throw new Error("KV PUT failed for some-key");
    }

    this.entries.set(key, { value });
  }

  revalidateTag(tag: string): string {
    return `${this.entries.size}:${tag}`;
  }
}

const request = () => new Request("https://example.org/");

describe(withDataCacheLog, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pending.length = 0;
  });

  it("totals the request's data reads on its event", async () => {
    const lines = captureLines();
    const handler = new MemoryHandler();
    const cache = withDataCacheLog(handler);

    handler.entries.set("fresh", { value: fetchValue("a") });
    handler.entries.set("old", { cacheState: "stale", value: fetchValue("b") });
    handler.entries.set("gone", {
      cacheState: "expired",
      value: fetchValue("c"),
    });
    handler.entries.set("page", { value: { kind: "APP_PAGE" } });

    const entry = withRequestLog(
      {
        fetch: async () => {
          await cache.get("fresh", fetchRead);
          await cache.get("old", fetchRead);
          await cache.get("gone", fetchRead);
          await cache.get("missing", fetchRead);
          // A rendered page is the event's `cache` field, not a data read.
          await cache.get("page", { kind: "APP_PAGE" });
          await cache.set("missing", fetchValue("d"));

          return new Response("ok");
        },
      },
      { service: "demo-web" }
    );

    await entry.fetch(request(), {}, ctx);

    expect(wideEvent(lines)).toMatchObject({
      dataCache: {
        hits: 1,
        misses: 2,
        readErrors: 0,
        stale: 1,
        writeErrors: 0,
      },
    });
    // Other methods keep their `this`.
    expect(cache.revalidateTag("x")).toBe("5:x");
  });

  it("warns when the store fails to read or write, and rethrows", async () => {
    const lines = captureLines();
    const handler = new MemoryHandler();
    const cache = withDataCacheLog(handler);

    handler.failReads = true;
    handler.failWrites = true;

    const entry = withRequestLog(
      {
        fetch: async () => {
          await expect(cache.get("key", fetchRead)).rejects.toThrow("KV GET");
          // A write the framework leaves to waitUntil, after the event.
          ctx.waitUntil(
            cache.set("key", fetchValue("a")).catch(() => "dropped")
          );

          return new Response("ok");
        },
      },
      { service: "demo-web" }
    );

    await entry.fetch(request(), {}, ctx);
    await Promise.all(pending);

    const event = wideEvent(lines);

    expect(event?.requestId).toStrictEqual(expect.any(String));
    expect(event).toMatchObject({
      dataCache: { readErrors: 1, writeErrors: 0 },
    });

    const warnings = lines.filter((line) => line.event === "data_cache.error");

    expect(warnings).toMatchObject([
      { cacheError: "read", errorName: "Error", requestId: event?.requestId },
      { cacheError: "write", errorName: "Error", requestId: event?.requestId },
    ]);
    // The store's message can quote the key, so it is never logged.
    expect(JSON.stringify(warnings)).not.toContain("some-key");
  });

  it("passes everything through outside a request", async () => {
    captureLines();
    const cache = withDataCacheLog(new MemoryHandler());

    await cache.set("key", fetchValue("a"));

    await expect(cache.get("key", fetchRead)).resolves.toStrictEqual({
      value: fetchValue("a"),
    });
  });
});

// A stale entry's refresh: it starts during the request and finishes after
// the response, with the given status from WordPress.
const backgroundRead = (status: number) =>
  timeUpstream(
    "wordpress",
    async () => {
      await delay(5);

      return new Response(null, { status });
    },
    (response) => response.status >= 500
  );

describe("upstream calls after the event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pending.length = 0;
  });

  it("logs a failed background call with the request's ID", async () => {
    const lines = captureLines();

    const entry = withRequestLog(
      {
        fetch: () => {
          ctx.waitUntil(backgroundRead(502));

          return new Response("stale page");
        },
      },
      { service: "demo-web" }
    );

    await entry.fetch(request(), {}, ctx);
    await Promise.all(pending);

    const event = wideEvent(lines);

    expect(event?.requestId).toStrictEqual(expect.any(String));
    expect(event).not.toHaveProperty("upstream");
    expect(
      lines.filter((line) => line.event === "upstream.failed")
    ).toMatchObject([
      {
        afterResponse: true,
        durationMs: expect.any(Number),
        requestId: event?.requestId,
        upstream: "wordpress",
      },
    ]);
  });

  it("logs nothing for a background call that succeeds", async () => {
    const lines = captureLines();

    const entry = withRequestLog(
      {
        fetch: () => {
          ctx.waitUntil(backgroundRead(200));

          return new Response("stale page");
        },
      },
      { service: "demo-web" }
    );

    await entry.fetch(request(), {}, ctx);
    await Promise.all(pending);

    expect(
      lines.filter((line) => line.event === "upstream.failed")
    ).toHaveLength(0);
  });
});
