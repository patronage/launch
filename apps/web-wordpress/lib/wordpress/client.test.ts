import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { WORDPRESS_CACHE_TAG } from "@patronage/wpgraphql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wpQuery } from "./client";

const cache = vi.hoisted(() => ({
  cacheLife: vi.fn<(profile: { expire: number; revalidate: number }) => void>(),
  cacheTag: vi.fn<(...tags: string[]) => void>(),
}));

const transport = vi.hoisted(() => ({
  wordpressFetch:
    vi.fn<
      (
        input: string,
        init?: RequestInit,
        previewJwt?: string | null
      ) => Promise<Response>
    >(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; the data cache exists only inside a Next request.
vi.mock("next/cache", () => cache);

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; request headers and cookies exist only inside a Next request.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve(new Headers({ "cf-access-jwt-assertion": "user-jwt" })),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; stands in for WordPress, so the test needs no network.
vi.mock("./fetch", () => transport);

const HASH = "a".repeat(64);

// What codegen emits: the operation's SHA-256 in __meta__ beside the AST.
// SAFETY: wpQuery reads only __meta__ from a document; the AST is never sent.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a stand-in for a codegen document.
const document = {
  __meta__: { hash: `sha256:${HASH}` },
  definitions: [],
  kind: "Document",
} as unknown as TypedDocumentNode<{ title: string }, { uri: string }>;

interface GraphQLAnswer {
  data?: { title?: string };
  errors?: { message: string }[];
}

const answer = (body: GraphQLAnswer, init: ResponseInit = {}) =>
  Response.json(body, init);

const sentRequest = () => {
  const [input, init] = transport.wordpressFetch.mock.calls[0] ?? [];

  return {
    body: JSON.parse(String(init?.body)),
    headers: new Headers(init?.headers),
    input,
  };
};

const taggedWith = () => cache.cacheTag.mock.calls.flat();

describe(wpQuery, () => {
  beforeEach(() => {
    vi.stubEnv("WORDPRESS_URL", "https://cms.example.org/");
    vi.stubEnv("WORDPRESS_PREVIEW_USER", "preview-bot");
    vi.stubEnv("WORDPRESS_PREVIEW_PASSWORD", "app-password");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("a public read", () => {
    it("sends only the persisted query ID and variables, with no credentials or preview header", async () => {
      transport.wordpressFetch.mockResolvedValue(
        answer({ data: { title: "About" } })
      );

      await expect(
        wpQuery(document, { uri: "/about/" })
      ).resolves.toStrictEqual({
        title: "About",
      });

      const { body, headers, input } = sentRequest();

      expect(input).toBe("https://cms.example.org/graphql");
      expect(body).toStrictEqual({
        queryId: HASH,
        variables: { uri: "/about/" },
      });
      expect(headers.has("authorization")).toBeFalsy();
      expect(headers.has("x-graphql-preview")).toBeFalsy();
    });

    it("is cached and tagged with the WordPress tag, the extra tags and the response's node keys", async () => {
      transport.wordpressFetch.mockResolvedValue(
        answer(
          { data: { title: "About" } },
          {
            headers: {
              "x-graphql-keys": `${HASH} graphql:Query operation:ContentByUri cG9zdDox list:post`,
            },
          }
        )
      );

      await wpQuery(document, { uri: "/about/" }, { tags: ["path:/about"] });

      expect(cache.cacheLife).toHaveBeenCalledOnce();
      expect(taggedWith()).toStrictEqual([
        WORDPRESS_CACHE_TAG,
        "path:/about",
        "cG9zdDox",
        "list:post",
      ]);
    });

    it("does not forward the visitor's Access assertion", async () => {
      transport.wordpressFetch.mockResolvedValue(answer({ data: {} }));

      await wpQuery(document, { uri: "/" });

      expect(transport.wordpressFetch.mock.calls[0]?.[2]).toBeUndefined();
    });
  });

  describe("a preview read", () => {
    it("authenticates as the preview user with WPGraphQL's preview context", async () => {
      transport.wordpressFetch.mockResolvedValue(
        answer({ data: { title: "Draft" } })
      );

      await expect(
        wpQuery(document, { uri: "/draft/" }, { previewDatabaseId: 42 })
      ).resolves.toStrictEqual({ title: "Draft" });

      const { body, headers } = sentRequest();

      expect(headers.get("authorization")).toBe(
        `Basic ${btoa("preview-bot:app-password")}`
      );
      expect(headers.get("x-graphql-preview")).toBe("database_id=42");
      expect(body).toStrictEqual({
        queryId: HASH,
        variables: { uri: "/draft/" },
      });
      expect(transport.wordpressFetch.mock.calls[0]?.[2]).toBe("user-jwt");
    });

    it("never touches the data cache", async () => {
      transport.wordpressFetch.mockResolvedValue(
        answer(
          { data: { title: "Draft" } },
          { headers: { "x-graphql-keys": "cG9zdDox" } }
        )
      );

      await wpQuery(document, { uri: "/draft/" }, { previewDatabaseId: 42 });

      expect(cache.cacheLife).not.toHaveBeenCalled();
      expect(cache.cacheTag).not.toHaveBeenCalled();
    });

    it("refuses to run without the preview user's credentials", async () => {
      vi.stubEnv("WORDPRESS_PREVIEW_PASSWORD", "");

      await expect(
        wpQuery(document, { uri: "/draft/" }, { previewDatabaseId: 42 })
      ).rejects.toThrow(/WORDPRESS_PREVIEW_PASSWORD/u);
      expect(transport.wordpressFetch).not.toHaveBeenCalled();
    });
  });

  it("throws for a document without a persisted query hash", async () => {
    // SAFETY: the shape of a document codegen did not register.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- deliberately not a codegen document.
    const unregistered = {
      definitions: [],
      kind: "Document",
    } as unknown as typeof document;

    await expect(wpQuery(unregistered, { uri: "/" })).rejects.toThrow(
      /persisted query hash/u
    );
    await expect(
      wpQuery(unregistered, { uri: "/" }, { previewDatabaseId: 1 })
    ).rejects.toThrow(/persisted query hash/u);
    expect(transport.wordpressFetch).not.toHaveBeenCalled();
  });

  it("surfaces a GraphQL errors answer and caches nothing", async () => {
    transport.wordpressFetch.mockResolvedValue(
      answer({ errors: [{ message: "First" }, { message: "Second" }] })
    );

    await expect(wpQuery(document, { uri: "/" })).rejects.toThrow(
      "WPGraphQL: First; Second"
    );
    expect(cache.cacheTag).not.toHaveBeenCalled();
  });

  it("surfaces an HTTP error status", async () => {
    transport.wordpressFetch.mockResolvedValue(
      new Response("down", { status: 503, statusText: "Service Unavailable" })
    );

    await expect(
      wpQuery(document, { uri: "/" }, { previewDatabaseId: 7 })
    ).rejects.toThrow("WPGraphQL answered 503 Service Unavailable");
  });

  it("throws when WPGraphQL returns no data", async () => {
    transport.wordpressFetch.mockResolvedValue(answer({}));

    await expect(wpQuery(document, { uri: "/" })).rejects.toThrow(
      "WPGraphQL returned no data"
    );
  });
});
