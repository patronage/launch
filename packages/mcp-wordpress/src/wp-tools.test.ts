import {
  UpstreamRequestError,
  createCallerScope,
  createUpstreamTelemetry,
} from "@patronage/mcp-core";
import type { ApplyPreflight, RuntimeStore } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WordPressEnv } from "./env";
import { createWordPressTools } from "./wp-tools";

const env: WordPressEnv = {
  WORDPRESS_API_URL: "https://wordpress.example",
};

const approvedPreflight: ApplyPreflight = {
  intent: "Rename",
  operations: [
    {
      editUrl: "https://wordpress.example/wp-admin/post.php?post=7&action=edit",
      fields: [],
      modifiedGmt: "2026-09-01T10:00:00",
      operationIndex: 0,
      sentence: "Update title on pages 7",
      slug: "launch",
      target: "pages/7",
    },
  ],
};

const renamePage = {
  intent: "Rename",
  operations: [
    {
      fields: { title: "New" },
      id: 7,
      kind: "update_post",
      rest_base: "pages",
    },
  ],
};

const memoryStore = (): RuntimeStore => {
  const preflights = new Map<string, ApplyPreflight>();
  const requesters = new Map<string, string>([["exec_1", "requester0000000"]]);

  return {
    readPreflight: (executionId) =>
      Promise.resolve(preflights.get(executionId)),
    readRequester: (executionId) =>
      Promise.resolve(requesters.get(executionId)),
    writePreflight: (executionId, preflight) => {
      preflights.set(executionId, preflight);

      return Promise.resolve();
    },
  };
};

const tools = (store: RuntimeStore = memoryStore()) => {
  const scope = createCallerScope();
  const telemetry = createUpstreamTelemetry();

  return {
    scope,
    store,
    telemetry,
    wp: createWordPressTools({ env, scope, store, telemetry: () => telemetry }),
  };
};

// Both readbacks in an applied write: the record before the write and the
// record WordPress stored after it.
const stubWriteRoundTrip = (): void => {
  const written = {
    id: 7,
    modified_gmt: "2026-09-01T10:00:00",
    title: { raw: "New", rendered: "New" },
  };

  let reads = 0;
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return Response.json(written);
    }

    reads += 1;

    return Response.json(
      reads === 1
        ? { id: 7, modified_gmt: "2026-09-01T10:00:00", title: { raw: "Old" } }
        : written
    );
  });
};

// Mirrors operations.test.ts's `thrownBy` for the async case: no-conditional-
// expect forbids expect() inside a catch block, so the rejection is captured
// here and every assertion runs unconditionally afterward. The generic (over
// a bare `unknown`) matches how the connector tools themselves stay clear of
// anti-slop(no-unknown-returns).
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

describe("wp connector tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts graphql to the site origin with the caller's forwarded token", async () => {
    const seen: { headers: Headers; url: string }[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ headers: new Headers(init?.headers), url: String(input) });

      return Response.json({ data: { generalSettings: { title: "Site" } } });
    });
    const { scope, wp } = tools();

    const result = await scope.run(
      { subjectOpaque: "aaaa", token: "caller-token" },
      () => wp.graphql.execute({ query: "{ generalSettings { title } }" })
    );

    expect(result).toStrictEqual({
      data: { generalSettings: { title: "Site" } },
    });
    expect(seen[0]?.url).toBe("https://wordpress.example/graphql");
    expect(seen[0]?.headers.get("X-Access-User-Jwt")).toBe("caller-token");
    expect(seen[0]?.headers.get("Authorization")).toBeNull();
  });

  it("restricts wp.get to /wp-json/ paths and appends the query", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      urls.push(String(input));

      return Response.json({ ok: true });
    });
    const { scope, wp } = tools();
    await scope.run({ subjectOpaque: "aaaa", token: "t" }, async () => {
      await wp.get.execute({
        path: "/wp-json/wp/v2/pages",
        query: { context: "edit", per_page: 5 },
      });
      await expect(
        wp.get.execute({ path: "/wp-admin/admin-ajax.php" })
      ).rejects.toThrow(/wp-json/u);
    });
    expect(urls[0]).toBe(
      "https://wordpress.example/wp-json/wp/v2/pages?context=edit&per_page=5"
    );
  });

  it("refuses a wp.get path that carries its own query string", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;

      return Response.json({});
    });
    const { scope, wp } = tools();

    const error = await scope.run({ subjectOpaque: "aaaa", token: "t" }, () =>
      rejectedWith(() =>
        wp.get.execute({ path: "/wp-json/wp/v2/pages?per_page=5" })
      )
    );

    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(error?.message).toContain("query");
    expect(calls).toBe(0);
  });

  it.each(["_method", ".method", "[method", " _method", "_METHOD"])(
    "refuses a wp.get method override named %j",
    async (key) => {
      let calls = 0;
      vi.stubGlobal("fetch", () => {
        calls += 1;

        return Response.json({});
      });
      const { scope, wp } = tools();

      const error = await scope.run({ subjectOpaque: "aaaa", token: "t" }, () =>
        rejectedWith(() =>
          wp.get.execute({
            path: "/wp-json/wp/v2/pages/7",
            query: { force: true, [key]: "DELETE" },
          })
        )
      );

      expect(error).toBeInstanceOf(UpstreamRequestError);
      expect(calls).toBe(0);
    }
  );

  it.each([
    'mutation { deletePage(input: {id: "7"}) { deletedId } }',
    "query Read { __typename } mutation Write { __typename }",
    "subscription { __typename }",
    "{ unclosed",
  ])(
    "refuses a wp.graphql document that is not only queries: %j",
    async (query) => {
      let calls = 0;
      vi.stubGlobal("fetch", () => {
        calls += 1;

        return Response.json({ data: {} });
      });
      const { scope, wp } = tools();

      const error = await scope.run({ subjectOpaque: "aaaa", token: "t" }, () =>
        rejectedWith(() => wp.graphql.execute({ query }))
      );

      expect(error).toBeInstanceOf(UpstreamRequestError);
      expect(calls).toBe(0);
    }
  );

  it("forwards a named query with variables and a fragment", async () => {
    vi.stubGlobal("fetch", () => Response.json({ data: { page: null } }));
    const { scope, wp } = tools();

    await expect(
      scope.run({ subjectOpaque: "aaaa", token: "t" }, () =>
        wp.graphql.execute({
          query:
            "query Page($id: ID!) { page(id: $id) { ...F } } fragment F on Page { title }",
          variables: { id: "7" },
        })
      )
    ).resolves.toStrictEqual({ data: { page: null } });
  });

  it("rejects wp.get on a 403 WordPress error without leaking the response body", async () => {
    vi.stubGlobal("fetch", () =>
      Response.json(
        { code: "rest_forbidden", message: "raw upstream message" },
        { status: 403 }
      )
    );
    const { scope, wp } = tools();

    const error = await scope.run({ subjectOpaque: "aaaa", token: "t" }, () =>
      rejectedWith(() => wp.get.execute({ path: "/wp-json/wp/v2/pages/7" }))
    );

    expect(error).toBeInstanceOf(UpstreamRequestError);

    if (!(error instanceof UpstreamRequestError)) {
      throw new TypeError(
        "expected wp.get to reject with UpstreamRequestError"
      );
    }

    expect(error.message).not.toContain("raw upstream message");
  });

  it("rejects wp.get on a 404 WordPress response", async () => {
    vi.stubGlobal("fetch", () =>
      Response.json(
        { code: "rest_post_invalid_id", message: "Invalid post ID." },
        { status: 404 }
      )
    );
    const { scope, wp } = tools();

    const error = await scope.run({ subjectOpaque: "aaaa", token: "t" }, () =>
      rejectedWith(() => wp.get.execute({ path: "/wp-json/wp/v2/pages/999" }))
    );

    expect(error).toBeInstanceOf(UpstreamRequestError);
  });

  it("collects a bounded record of every WordPress request the tools made", async () => {
    vi.stubGlobal("fetch", () => Response.json({ ok: true }));
    const { scope, telemetry, wp } = tools();
    await scope.run({ subjectOpaque: "aaaa", token: "t" }, async () => {
      await wp.get.execute({
        path: "/wp-json/wp/v2/pages",
        query: { context: "edit" },
      });
      await wp.graphql.execute({ query: "{ __typename }" });
    });

    expect(telemetry.wordpress).toStrictEqual({
      auth: "access-jwt",
      requests: [
        {
          durationMs: expect.any(Number),
          method: "GET",
          outcome: "success",
          path: "/wp-json/wp/v2/pages",
          status: 200,
        },
        {
          durationMs: expect.any(Number),
          method: "POST",
          outcome: "success",
          path: "/graphql",
          status: 200,
        },
      ],
      target: "wordpress.example",
    });
  });

  it("marks wp.apply as requiring approval and validates its operations", async () => {
    const { scope, wp } = tools();
    expect(wp.apply.requiresApproval).toBeTruthy();
    await scope.run({ subjectOpaque: "aaaa", token: "t" }, async () => {
      await expect(
        wp.apply.execute(
          { intent: "Bad", operations: [] },
          {
            executionId: "exec_1",
          }
        )
      ).rejects.toThrow(/operations/u);
      await expect(
        wp.apply.execute(
          {
            intent: "Twice",
            operations: [
              {
                fields: { title: "One" },
                id: 7,
                kind: "update_post",
                rest_base: "pages",
              },
              {
                fields: { title: "Two" },
                id: 7,
                kind: "update_post",
                rest_base: "pages",
              },
            ],
          },
          { executionId: "exec_1" }
        )
      ).rejects.toMatchObject({ code: "duplicate_target" });
    });
  });

  it("applies the stored preflight and returns a receipt naming both subjects", async () => {
    const store = memoryStore();
    await store.writePreflight("exec_1", approvedPreflight);
    stubWriteRoundTrip();
    const { scope, wp } = tools(store);

    const receipt = await scope.run(
      { subjectOpaque: "approver00000000", token: "approver-token" },
      () => wp.apply.execute(renamePage, { executionId: "exec_1" })
    );

    expect(receipt).toMatchObject({
      approverOpaque: "approver00000000",
      executionId: "exec_1",
      requesterOpaque: "requester0000000",
      status: "succeeded",
    });
  });

  it("falls back to the execution id on the caller when the runtime omits it", async () => {
    const store = memoryStore();
    await store.writePreflight("exec_1", approvedPreflight);
    stubWriteRoundTrip();
    const { scope, wp } = tools(store);

    const receipt = await scope.run(
      {
        executionId: "exec_1",
        subjectOpaque: "approver00000000",
        token: "approver-token",
      },
      () => wp.apply.execute(renamePage)
    );

    expect(receipt).toMatchObject({
      executionId: "exec_1",
      requesterOpaque: "requester0000000",
      status: "succeeded",
    });
  });

  it("refuses to write when no approved preview is stored for the execution", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;

      return Response.json({});
    });
    const { scope, wp } = tools();

    const receipt = await scope.run(
      { subjectOpaque: "approver00000000", token: "approver-token" },
      () => wp.apply.execute(renamePage, { executionId: "exec_1" })
    );

    expect(receipt).toMatchObject({
      operations: [{ error: { code: "missing_preflight" }, status: "failed" }],
      status: "failed",
    });
    expect(calls).toBe(0);
  });

  it("refuses wp.apply without an execution id from either source", async () => {
    const { scope, wp } = tools();
    await scope.run({ subjectOpaque: "aaaa", token: "t" }, async () => {
      await expect(wp.apply.execute(renamePage)).rejects.toThrow(
        /execution id/u
      );
    });
  });
});
