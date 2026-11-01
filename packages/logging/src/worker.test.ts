import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withRequestLog } from "./worker.ts";

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
});
