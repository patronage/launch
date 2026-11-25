import { verifyGatewayProof } from "@patronage/access";
import {
  ApplyValidationError,
  UpstreamRequestError,
  createCallerScope,
  createUpstreamTelemetry,
} from "@patronage/mcp-core";
import type { JsonValue, RuntimeStore } from "@patronage/mcp-core";
import { describe, expect, it, vi } from "vitest";

import { describeEmDash } from "./describe";
import { createEmDashClient, emdashAdminUrl, emdashConfigured } from "./emdash";
import { readablePath } from "./emdash-read";
import { createEmDashTools } from "./emdash-tools";
import type { EmDashEnv } from "./env";
import { emdashConnector } from "./gateway";

const caller = { subjectOpaque: "editor0000000000", token: "editor-jwt" };

interface Seen {
  headers: Headers;
  method: string;
  url: string;
}

const ok = (data: JsonValue) => Response.json({ data, success: true });

// An EmDash Worker stand-in on a Service binding: it records each request
// and answers the few routes the connector reads.
const fakeEmDash = () => {
  const seen: Seen[] = [];

  const answers = new Map<string, () => Response>(
    Object.entries({
      "/_emdash/api/auth/me": () => ok({ email: "e@example.com", role: 40 }),
      "/_emdash/api/content/pages": () =>
        ok({ items: [{ id: "01A", slug: "home" }], total: 1 }),
      "/_emdash/api/content/pages/01A": () =>
        Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Content item not found: 01A",
            },
          },
          { status: 404 }
        ),
      "/_emdash/api/schema/collections": () =>
        ok({
          items: [
            {
              label: "Pages",
              slug: "pages",
              supports: ["drafts", "revisions"],
            },
            { hidden: true, label: "Internal", slug: "internal", supports: [] },
          ],
        }),
      "/_emdash/api/schema/collections/pages": () =>
        ok({
          item: {
            fields: [
              { required: true, slug: "title", type: "string" },
              { slug: "body", type: "portableText" },
            ],
            label: "Pages",
            slug: "pages",
            supports: ["drafts", "revisions"],
            urlPattern: "/{slug}",
          },
        }),
      "/_emdash/api/taxonomies": () =>
        ok({
          taxonomies: [
            { collections: ["news"], hierarchical: false, name: "category" },
          ],
        }),
    })
  );

  const fetcher = {
    connect: vi.fn<Fetcher["connect"]>(),
    fetch: vi.fn<Fetcher["fetch"]>((input, init) => {
      const url = new URL(String(input));
      seen.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: url.toString(),
      });
      const answer = answers.get(url.pathname);

      return Promise.resolve(
        answer ? answer() : new Response("not found", { status: 404 })
      );
    }),
  } satisfies Fetcher;

  const env: EmDashEnv = {
    EMDASH: fetcher,
    EMDASH_ACCESS_PROOF_SECRET: "proof-secret",
  };

  return { env, seen };
};

const memoryStore = (): RuntimeStore => ({
  readPreflight: () => Promise.resolve(undefined),
  readRequester: () => Promise.resolve("requester0000000"),
  writePreflight: () => Promise.resolve(),
});

const tools = (env: EmDashEnv) => {
  const scope = createCallerScope();

  return {
    emdash: createEmDashTools({
      env,
      scope,
      store: memoryStore(),
      telemetry: () => createUpstreamTelemetry(),
    }),
    scope,
  };
};

describe(readablePath, () => {
  it.each([
    "/_emdash/api/content/pages",
    "/_emdash/api/content/pages/01A",
    "/_emdash/api/content/pages/01A/revisions",
    "/_emdash/api/content/pages/trash",
    "/_emdash/api/content/news/01A/terms/category",
    "/_emdash/api/schema/collections/pages",
    "/_emdash/api/media/01M",
    "/_emdash/api/menus/main",
    "/_emdash/api/taxonomies/category/terms",
    "/_emdash/api/search",
  ])("reads %s", (path) => {
    expect(readablePath({ path })).toBe(path);
  });

  it("adds scalar query values", () => {
    expect(
      readablePath({
        path: "/_emdash/api/content/pages",
        query: { limit: 5, status: "draft" },
      })
    ).toBe("/_emdash/api/content/pages?limit=5&status=draft");
  });

  it.each([
    "/_emdash/api/auth/me",
    "/_emdash/api/admin/users",
    "/_emdash/api/settings",
    "/_emdash/api/content/pages/authors",
    "/_emdash/api/content/pages/01A/lock",
    "/_emdash/api/content/pages/01A/room",
    "/_emdash/api/content/pages/01A/preview-url",
    "/_emdash/api/mcp",
    "/_emdash/api/media/file/abc",
    "/_emdash/api/content/../admin/users",
    "/_emdash/api/content/pages%2F01A",
    "/_emdash/admin",
    "/wp-json/wp/v2/posts",
  ])("refuses %s", (path) => {
    expect(() => readablePath({ path })).toThrow(UpstreamRequestError);
  });

  it("refuses a path with its own query string", () => {
    expect(() =>
      readablePath({ path: "/_emdash/api/content/pages?limit=1" })
    ).toThrow(/query argument/u);
  });
});

describe(createEmDashClient, () => {
  it("needs the proof secret", () => {
    expect(() =>
      createEmDashClient({ EMDASH_API_URL: "https://site.example" }, caller)
    ).toThrow(/EMDASH_ACCESS_PROOF_SECRET/u);
  });

  it("refuses a plain-HTTP origin outside localhost", () => {
    expect(() =>
      createEmDashClient(
        {
          EMDASH_ACCESS_PROOF_SECRET: "proof-secret",
          EMDASH_API_URL: "http://site.example",
        },
        caller
      )
    ).toThrow(UpstreamRequestError);
  });

  it("carries the service token when EmDash is reached by URL", () => {
    expect(
      createEmDashClient(
        {
          EMDASH_ACCESS_CLIENT_ID: "client-id",
          EMDASH_ACCESS_CLIENT_SECRET: "client-secret",
          EMDASH_ACCESS_PROOF_SECRET: "proof-secret",
          EMDASH_API_URL: "https://site.example",
        },
        caller
      ).auth.serviceToken
    ).toStrictEqual({ clientId: "client-id", clientSecret: "client-secret" });
  });
});

describe(emdashConfigured, () => {
  it("is on with a binding or a URL, off with neither", () => {
    expect(emdashConfigured({})).toBeFalsy();
    expect(emdashConfigured({ EMDASH_API_URL: " " })).toBeFalsy();
    expect(
      emdashConfigured({ EMDASH_API_URL: "https://site.example" })
    ).toBeTruthy();
  });
});

describe("emdash.get", () => {
  it("reads as the editor, with the gateway proof and EmDash's request header", async () => {
    const { env, seen } = fakeEmDash();
    const { emdash, scope } = tools(env);

    await expect(
      scope.run(caller, () =>
        emdash.get.execute({
          path: "/_emdash/api/content/pages",
          query: { limit: 1 },
        })
      )
    ).resolves.toStrictEqual({
      items: [{ id: "01A", slug: "home" }],
      total: 1,
    });

    const [request] = seen;
    expect(request?.url).toBe(
      "https://emdash.internal/_emdash/api/content/pages?limit=1"
    );
    expect(request?.headers.get("X-Access-User-Jwt")).toBe("editor-jwt");
    expect(request?.headers.get("X-EmDash-Request")).toBe("1");
    await expect(
      verifyGatewayProof(
        request?.headers.get("X-Access-Gateway-Proof") ?? "",
        "editor-jwt",
        "proof-secret"
      )
    ).resolves.toBeTruthy();
  });

  it("passes on EmDash's error code and message", async () => {
    const { env } = fakeEmDash();
    const { emdash, scope } = tools(env);

    await expect(
      scope.run(caller, () =>
        emdash.get.execute({ path: "/_emdash/api/content/pages/01A" })
      )
    ).rejects.toThrow("EmDash NOT_FOUND: Content item not found: 01A");
  });

  it("refuses a route outside the allowlist without calling EmDash", async () => {
    const { env, seen } = fakeEmDash();
    const { emdash, scope } = tools(env);

    await expect(
      scope.run(caller, () =>
        emdash.get.execute({ path: "/_emdash/api/admin/users" })
      )
    ).rejects.toThrow(UpstreamRequestError);
    expect(seen).toHaveLength(0);
  });
});

describe(describeEmDash, () => {
  it("lists visible collections with their fields, the taxonomies and the editor's role", async () => {
    const { env } = fakeEmDash();

    await expect(
      describeEmDash(createEmDashClient(env, caller), createUpstreamTelemetry())
    ).resolves.toStrictEqual({
      collections: [
        {
          fields: [
            { required: true, slug: "title", type: "string" },
            { slug: "body", type: "portableText" },
          ],
          label: "Pages",
          slug: "pages",
          supports: ["drafts", "revisions"],
          urlPattern: "/{slug}",
        },
      ],
      taxonomies: [{ collections: ["news"], name: "category" }],
      user: { role: "editor" },
    });
  });
});

describe(emdashConnector.parseApply, () => {
  it("refuses every apply batch", () => {
    expect(() =>
      emdashConnector.parseApply({ intent: "x", operations: [] })
    ).toThrow(ApplyValidationError);
  });
});

describe(emdashAdminUrl, () => {
  it("links an entry in the admin when the public origin is known", () => {
    expect(
      emdashAdminUrl(
        { EMDASH_ADMIN_URL: "https://site.example" },
        "pages",
        "01A"
      )
    ).toBe("https://site.example/_emdash/admin/content/pages/01A");
    expect(emdashAdminUrl({}, "pages", "01A")).toBe("");
  });
});
