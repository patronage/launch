import {
  ApplyConflictError,
  createUpstreamTelemetry,
  deepEqual,
  delay,
  previewValue,
} from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  JsonObject,
  OperationPreflight,
  UpstreamClient,
} from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectWordPressResponse } from "./wordpress";
import { applyOperations, preflightOperations } from "./wp-apply";
import type { WriteOperation } from "./wp-operations";

const client: UpstreamClient = {
  apiUrl: "https://wordpress.example",
  auth: { kind: "access-jwt", token: "caller-token" },
  inspect: inspectWordPressResponse,
  label: "WordPress",
};

const operation: WriteOperation = {
  acf: { hero_heading: "New heading" },
  fields: { title: "New title" },
  id: 42,
  kind: "update_post",
  rest_base: "pages",
};

const record = (overrides: JsonObject = {}) => ({
  acf: { hero_heading: "Old heading" },
  id: 42,
  modified_gmt: "2026-09-01T10:00:00",
  slug: "launch",
  status: "draft",
  title: { raw: "Old title", rendered: "Old title" },
  ...overrides,
});

const snapshotFor = (index: number, id: number): OperationPreflight => ({
  editUrl: `https://wordpress.example/wp-admin/post.php?post=${id}&action=edit`,
  fields: [],
  modifiedGmt: "2026-09-01T10:00:00",
  operationIndex: index,
  sentence: `Update title and acf.hero_heading on pages ${id}`,
  slug: "launch",
  target: `pages/${id}`,
});

// Mirrors connector.test.ts: no-conditional-expect forbids expect() inside a
// catch block, so the rejection is captured here and every assertion runs
// unconditionally afterward.
const rejectedWith = async <T>(
  fn: () => Promise<T>
): Promise<Error | undefined> => {
  try {
    await fn();

    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw error;
  }
};

describe("previewValue and deepEqual", () => {
  it("truncates long strings to the preview limit", () => {
    const preview = previewValue("x".repeat(600));
    expect(preview).toHaveLength(401);
    expect(preview.endsWith("…")).toBeTruthy();
  });

  it("compares acf objects by value, not key order", () => {
    // `sort-keys` forbids writing the reordered literal directly, so the
    // differently-ordered twin is built by reversing the insertion order.
    const reordered = Object.fromEntries(
      Object.entries({ a: 1, b: [2, 3] }).toReversed()
    );

    expect(Object.keys(reordered)).toStrictEqual(["b", "a"]);
    expect(deepEqual({ a: 1, b: [2, 3] }, reordered)).toBeTruthy();
    expect(deepEqual({ a: 1 }, { a: 2 })).toBeFalsy();
  });
});

describe(preflightOperations, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures modified_gmt and a before/after row for each changed path", async () => {
    vi.stubGlobal("fetch", () => Response.json(record()));

    const preflight = await preflightOperations(
      client,
      "Rename the launch page",
      [operation],
      createUpstreamTelemetry()
    );

    const [first] = preflight.operations;
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      modifiedGmt: "2026-09-01T10:00:00",
      sentence: "Update title and acf.hero_heading on pages 42",
      slug: "launch",
    });
    expect(first?.editUrl).toBe(
      "https://wordpress.example/wp-admin/post.php?post=42&action=edit"
    );
    expect(first?.fields).toStrictEqual([
      { after: "New title", before: "Old title", changed: true, path: "title" },
      {
        after: "New heading",
        before: "Old heading",
        changed: true,
        path: "acf.hero_heading",
      },
    ]);
  });

  it("refuses a post whose modified_gmt WordPress did not report", async () => {
    vi.stubGlobal("fetch", () =>
      Response.json(record({ modified_gmt: undefined }))
    );

    const failure = await rejectedWith(() =>
      preflightOperations(
        client,
        "Rename",
        [operation],
        createUpstreamTelemetry()
      )
    );

    expect(failure).toBeInstanceOf(ApplyConflictError);
    expect(failure).toMatchObject({ code: "unreadable_modified_gmt" });
  });

  it("rejects a stale expected_modified_gmt with a typed error", async () => {
    vi.stubGlobal("fetch", () => Response.json(record()));
    await expect(
      preflightOperations(
        client,
        "Rename",
        [{ ...operation, expected_modified_gmt: "2026-08-01T10:00:00" }],
        createUpstreamTelemetry()
      )
    ).rejects.toBeInstanceOf(ApplyConflictError);
  });
});

const runBatch = async (
  operations: WriteOperation[],
  preflight: ApplyPreflight,
  handler: (request: Request) => Response
) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))
  );

  return await applyOperations({
    approverOpaque: "approver00000000",
    client,
    executionId: "exec_1",
    operations,
    preflight,
    requesterOpaque: "requester0000000",
    telemetry: createUpstreamTelemetry(),
  });
};

const runOne = async (handler: (request: Request) => Response) =>
  await runBatch(
    [operation],
    {
      intent: "Rename the launch page",
      operations: [snapshotFor(0, 42)],
    },
    handler
  );

describe(applyOperations, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a changed receipt when the readback matches the request", async () => {
    const written = record({
      acf: { hero_heading: "New heading" },
      title: { raw: "New title", rendered: "New title" },
    });

    let reads = 0;

    const receipt = await runOne((request) => {
      if (request.method === "POST") {
        return Response.json(written);
      }

      reads += 1;

      return Response.json(reads === 1 ? record() : written);
    });

    expect(receipt.status).toBe("succeeded");
    expect(receipt.operations[0]).toStrictEqual({
      changed_paths: ["title", "acf.hero_heading"],
      kind: "update_post",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "pages/42",
    });
    expect(receipt.approverOpaque).toBe("approver00000000");
    expect(receipt.requesterOpaque).toBe("requester0000000");
  });

  it("returns a conflict receipt and writes nothing when modified_gmt moved", async () => {
    let posts = 0;

    const receipt = await runOne((request) => {
      if (request.method === "POST") {
        posts += 1;
      }

      return Response.json(record({ modified_gmt: "2026-09-02T09:00:00" }));
    });

    expect(posts).toBe(0);
    expect(receipt.status).toBe("failed");
    expect(receipt.operations[0]?.status).toBe("conflict");
    expect(receipt.operations[0]?.error?.code).toBe("modified_since_preflight");
  });

  it("returns a conflict receipt when the pre-write read has no modified_gmt", async () => {
    let posts = 0;

    const receipt = await runOne((request) => {
      if (request.method === "POST") {
        posts += 1;
      }

      return Response.json(record({ modified_gmt: undefined }));
    });

    expect(posts).toBe(0);
    expect(receipt.status).toBe("failed");
    expect(receipt.operations[0]?.status).toBe("conflict");
    expect(receipt.operations[0]?.error?.code).toBe("unreadable_modified_gmt");
  });

  it("returns readback_mismatch when a requested field did not land", async () => {
    const receipt = await runOne(() => Response.json(record()));
    expect(receipt.status).toBe("failed");
    expect(receipt.operations[0]?.status).toBe("failed");
    expect(receipt.operations[0]?.error?.code).toBe("readback_mismatch");
  });

  it("counts a value WordPress normalised as changed, not missed", async () => {
    const slugOperation: WriteOperation = {
      fields: { slug: "Launch Page" },
      id: 42,
      kind: "update_post",
      rest_base: "pages",
    };

    const sanitized = record({ slug: "launch-page" });
    let reads = 0;

    const receipt = await runBatch(
      [slugOperation],
      { intent: "Rename the slug", operations: [snapshotFor(0, 42)] },
      (request) => {
        if (request.method === "POST") {
          return Response.json(sanitized);
        }

        reads += 1;

        return Response.json(reads === 1 ? record() : sanitized);
      }
    );

    expect(receipt.status).toBe("succeeded");
    expect(receipt.operations[0]).toStrictEqual({
      changed_paths: ["slug"],
      kind: "update_post",
      normalized_paths: ["slug"],
      operation_index: 0,
      status: "changed",
      target: "pages/42",
    });
  });

  it("fails readback when an acf key still holds its preflight value", async () => {
    const landed = record({
      title: { raw: "New title", rendered: "New title" },
    });

    let reads = 0;

    const receipt = await runOne((request) => {
      if (request.method === "POST") {
        return Response.json(landed);
      }

      reads += 1;

      return Response.json(reads === 1 ? record() : landed);
    });

    expect(receipt.operations[0]).toStrictEqual({
      changed_paths: ["title"],
      error: {
        code: "readback_mismatch",
        message: "WordPress did not store acf.hero_heading",
      },
      kind: "update_post",
      normalized_paths: [],
      operation_index: 0,
      status: "failed",
      target: "pages/42",
    });
  });

  it("caps the missed paths listed in a readback_mismatch message", async () => {
    const wide: WriteOperation = {
      acf: { banner_text: "New banner", hero_heading: "New heading" },
      fields: {
        content: "New body",
        excerpt: "New excerpt",
        slug: "new-slug",
        status: "publish",
        title: "New title",
      },
      id: 42,
      kind: "update_post",
      rest_base: "pages",
    };

    const receipt = await runBatch(
      [wide],
      { intent: "Rewrite the page", operations: [snapshotFor(0, 42)] },
      () => Response.json(record())
    );

    expect(receipt.operations[0]?.error?.message).toBe(
      "WordPress did not store title, content, excerpt, slug, status and 2 more"
    );
  });

  it("keeps the batch receipt and later operations when a write throws", async () => {
    const written = record({
      acf: { hero_heading: "New heading" },
      title: { raw: "New title", rendered: "New title" },
    });

    let posts = 0;
    let reads = 0;

    const receipt = await runBatch(
      [operation, { ...operation, id: 43 }],
      {
        intent: "Rename both pages",
        operations: [snapshotFor(0, 42), snapshotFor(1, 43)],
      },
      (request) => {
        if (request.method === "POST") {
          posts += 1;

          // A PHP fatal inside a save_post hook: HTTP 200, HTML body.
          return posts === 1
            ? new Response("<b>Fatal error</b>", {
                headers: { "content-type": "text/html" },
                status: 200,
              })
            : Response.json(written);
        }

        reads += 1;

        return Response.json(reads === 3 ? written : record());
      }
    );

    expect(posts).toBe(2);
    expect(receipt.status).toBe("partial");
    expect(receipt.operations).toHaveLength(2);
    expect(receipt.operations[0]).toStrictEqual({
      changed_paths: [],
      error: {
        code: "wordpress_request_failed",
        message: "WordPress returned invalid JSON",
      },
      kind: "update_post",
      normalized_paths: [],
      operation_index: 0,
      status: "failed",
      target: "pages/42",
    });
    expect(receipt.operations[1]?.status).toBe("changed");
  });

  it("fails with preflight_mismatch and no fetch when the snapshot describes another target", async () => {
    let calls = 0;

    const receipt = await runBatch(
      [operation],
      { intent: "Mismatched approval", operations: [snapshotFor(0, 999)] },
      () => {
        calls += 1;

        return Response.json(record());
      }
    );

    expect(calls).toBe(0);
    expect(receipt.status).toBe("failed");
    expect(receipt.operations[0]?.status).toBe("failed");
    expect(receipt.operations[0]?.error?.code).toBe("preflight_mismatch");
    expect(receipt.operations[0]?.target).toBe("pages/42");
  });

  it("returns a failed receipt carrying the WordPress error code", async () => {
    let reads = 0;

    const receipt = await runOne((request) => {
      if (request.method === "POST") {
        return Response.json(
          { code: "rest_forbidden", message: "raw upstream message" },
          { status: 403 }
        );
      }

      reads += 1;

      return Response.json(record());
    });

    expect(reads).toBe(1);
    expect(receipt.operations[0]?.error?.code).toBe("rest_forbidden");
    expect(JSON.stringify(receipt)).not.toContain("raw upstream message");
  });
});

describe("update_post meta", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const metaOperation: WriteOperation = {
    id: 42,
    kind: "update_post",
    meta: { _seo_description: "New summary" },
    rest_base: "pages",
  };

  it("previews the registered meta value", async () => {
    vi.stubGlobal("fetch", () =>
      Response.json(record({ meta: { _seo_description: "Old summary" } }))
    );

    const preflight = await preflightOperations(
      client,
      "Set the description",
      [metaOperation],
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]?.fields).toStrictEqual([
      {
        after: "New summary",
        before: "Old summary",
        changed: true,
        path: "meta._seo_description",
      },
    ]);
  });

  it("writes meta in the REST body and reports it changed", async () => {
    let stored = "Old summary";
    const bodies: (BodyInit | null | undefined)[] = [];

    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        stored = "New summary";
        bodies.push(init.body);

        return Response.json({ id: 42 });
      }

      return Response.json(record({ meta: { _seo_description: stored } }));
    });

    const receipt = await applyOperations({
      approverOpaque: "approver00000000",
      client,
      executionId: "exec_1",
      operations: [metaOperation],
      preflight: { intent: "Set", operations: [snapshotFor(0, 42)] },
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["meta._seo_description"],
      status: "changed",
    });
    expect(bodies).toStrictEqual([
      JSON.stringify({ meta: { _seo_description: "New summary" } }),
    ]);
  });

  it("fails readback when WordPress drops an unregistered key", async () => {
    const receipt = await runBatch(
      [metaOperation],
      { intent: "Set", operations: [snapshotFor(0, 42)] },
      (request) =>
        request.method === "POST"
          ? Response.json({ id: 42 })
          : Response.json(record({ meta: [] }))
    );

    expect(receipt.operations[0]).toMatchObject({
      error: { code: "readback_mismatch" },
      status: "failed",
    });
  });
});

describe("applyOperations concurrency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const posts = [41, 42, 43, 44, 45];

  const batch: WriteOperation[] = posts.map((id) => ({
    fields: { title: "New title" },
    id,
    kind: "update_post",
    rest_base: "pages",
  }));

  const preflight: ApplyPreflight = {
    intent: "Retitle",
    operations: posts.map((id, index) => snapshotFor(index, id)),
  };

  it("runs two operations at a time, reports each one, and keeps index order", async () => {
    const written = new Set<string>();
    let inFlight = 0;
    let peak = 0;

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const id = Number(path.split("/").at(-1));
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Later posts answer faster, so settling order differs from index order.
        await delay((50 - id) * 2);
        inFlight -= 1;

        if (request.method === "POST") {
          written.add(path);

          return Response.json({ id });
        }

        return Response.json(
          written.has(path)
            ? record({ id, title: { raw: "New title", rendered: "New title" } })
            : record({ id })
        );
      }
    );

    const reported: number[] = [];

    const receipt = await applyOperations({
      approverOpaque: "approver00000000",
      client,
      executionId: "exec_1",
      onProgress: (item) => {
        reported.push(item.operation_index);

        return Promise.resolve();
      },
      operations: batch,
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(peak).toBe(2);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.operations.map((item) => item.target)).toStrictEqual(
      posts.map((id) => `pages/${id}`)
    );
    expect(reported.toSorted()).toStrictEqual([0, 1, 2, 3, 4]);
  });

  it("keeps writing when recording progress fails", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({})
        : Response.json(
            record({
              id: Number(new URL(String(input)).pathname.split("/").at(-1)),
            })
          )
    );

    const receipt = await applyOperations({
      approverOpaque: "approver00000000",
      client,
      executionId: "exec_1",
      onProgress: () => Promise.reject(new Error("storage unavailable")),
      operations: batch.slice(0, 2),
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations).toHaveLength(2);
  });
});
