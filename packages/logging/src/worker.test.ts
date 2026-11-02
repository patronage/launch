import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { timedD1, timeUpstream, withRequestLog } from "./worker.ts";

const ctx = { waitUntil: () => {} };

const eventSchema = z
  .object({
    method: z.string(),
    path: z.string(),
    service: z.string(),
    status: z.number(),
  })
  .loose();

const captureConsole = () => {
  const lines: unknown[] = [];

  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(...args);
    });
  }

  return () =>
    lines.flatMap((line) => {
      const parsed = eventSchema.safeParse(line);

      return parsed.success ? [parsed.data] : [];
    });
};

describe(withRequestLog, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one wide event per request with the service and status", async () => {
    const loggedEvents = captureConsole();

    const entry = withRequestLog(
      { fetch: () => new Response("ok", { status: 201 }) },
      { environment: "test", service: "demo-web" }
    );

    const response = await entry.fetch(
      new Request("https://example.org/about?draft=1"),
      {},
      ctx
    );

    expect(response.status).toBe(201);

    const events = loggedEvents();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "GET",
      path: "/about",
      service: "demo-web",
      status: 201,
    });
  });

  it("skips build assets", async () => {
    const loggedEvents = captureConsole();

    const entry = withRequestLog(
      { fetch: () => new Response("asset") },
      { service: "demo-web" }
    );

    await entry.fetch(
      new Request("https://example.org/_next/static/app.js"),
      {},
      ctx
    );

    expect(loggedEvents()).toHaveLength(0);
  });

  it("keeps the entry's other handlers and its this", async () => {
    captureConsole();
    const scheduled = vi.fn<() => void>();

    const original = {
      body: "from this",
      fetch(this: { body: string }) {
        return new Response(this.body);
      },
      scheduled,
    };

    const entry = withRequestLog(original, { service: "demo-web" });

    const response = await entry.fetch(
      new Request("https://example.org/"),
      {},
      ctx
    );

    await expect(response.text()).resolves.toBe("from this");
    expect(entry.scheduled).toBe(scheduled);
  });

  it("adds the vinext cache result and upstream totals", async () => {
    const loggedEvents = captureConsole();

    const entry = withRequestLog(
      {
        fetch: async () => {
          await timeUpstream("wordpress", () => Promise.resolve("first"));
          await timeUpstream("wordpress", () => Promise.resolve("second"));

          return new Response("page", {
            headers: { "X-Vinext-Cache": "MISS" },
          });
        },
      },
      { service: "demo-web" }
    );

    const response = await entry.fetch(
      new Request("https://example.org/"),
      {},
      ctx
    );

    await expect(response.text()).resolves.toBe("page");
    expect(loggedEvents()[0]).toMatchObject({
      cache: "MISS",
      upstream: { wordpress: { calls: 2, errors: 0 } },
    });
  });

  it("counts failed upstream calls", async () => {
    const loggedEvents = captureConsole();

    const entry = withRequestLog(
      {
        fetch: async () => {
          await timeUpstream("wordpress", () => {
            throw new Error("down");
          }).catch(() => "fallback");

          return new Response("fallback");
        },
      },
      { service: "demo-web" }
    );

    await entry.fetch(new Request("https://example.org/"), {}, ctx);

    expect(loggedEvents()[0]).toMatchObject({
      upstream: { wordpress: { calls: 1, errors: 1 } },
    });
  });
});

describe(timedD1, () => {
  // Stands in for D1, whose methods only accept their own objects.
  class Statement {
    readonly sql: string;
    constructor(sql: string) {
      this.sql = sql;
    }
    bind() {
      return new Statement(this.sql);
    }
    all() {
      if (!(this instanceof Statement)) {
        throw new TypeError("Illegal invocation");
      }

      return Promise.resolve({ results: [this.sql] });
    }
  }

  const fakeDatabase = {
    batch(statements: Statement[]) {
      if (!statements.every((statement) => statement instanceof Statement)) {
        throw new TypeError("batch() needs real statements");
      }

      return Promise.resolve(statements.map(() => ({ results: [] })));
    },
    prepare: (sql: string) => new Statement(sql),
  };

  it("times queries and passes real statements to batch", async () => {
    const loggedEvents = captureConsole();
    const database = timedD1(fakeDatabase);

    const entry = withRequestLog(
      {
        fetch: async () => {
          const statement = database.prepare("select 1").bind();

          await expect(statement.all()).resolves.toStrictEqual({
            results: ["select 1"],
          });
          await database.batch([statement, database.prepare("select 2")]);

          return new Response(null, { status: 204 });
        },
      },
      { service: "demo-web" }
    );

    await entry.fetch(new Request("https://example.org/"), {}, ctx);

    expect(loggedEvents()[0]).toMatchObject({
      upstream: { d1: { calls: 2, errors: 0 } },
    });
  });

  it("runs work unchanged outside a request", async () => {
    await expect(
      timeUpstream("outside", () => Promise.resolve("no store"))
    ).resolves.toBe("no store");
  });
});
