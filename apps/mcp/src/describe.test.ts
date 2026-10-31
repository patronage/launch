import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSiteDescription,
  isFresh,
  parsePostTypes,
  summarizeSchema,
} from "./describe";
import { createWordPressTelemetry, WordPressRequestError } from "./wordpress";
import type { WordPressClient } from "./wordpress";

const client: WordPressClient = {
  apiUrl: "https://wordpress.example",
  auth: { kind: "access-jwt", token: "caller-token" },
};

const typesResponse = {
  page: {
    name: "Pages",
    rest_base: "pages",
    slug: "page",
    supports: { editor: true, thumbnail: false, title: true },
    taxonomies: ["category"],
  },
  wp_block: { name: "Blocks", slug: "wp_block", supports: { editor: true } },
};

const schemaResponse = {
  data: {
    __schema: {
      types: [
        {
          fields: [
            {
              name: "title",
              type: { kind: "SCALAR", name: "String", ofType: null },
            },
            { name: "status", type: { kind: "ENUM", name: "PostStatusEnum" } },
            {
              name: "author",
              type: {
                kind: "OBJECT",
                name: "NodeWithAuthorToUserConnectionEdge",
              },
            },
            {
              name: "databaseId",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "Int" },
              },
            },
          ],
          interfaces: [{ name: "ContentNode" }, { name: "Node" }],
          kind: "OBJECT",
          name: "Page",
        },
        {
          fields: [
            { name: "heroHeading", type: { kind: "SCALAR", name: "String" } },
          ],
          interfaces: [{ name: "AcfFieldGroup" }],
          kind: "OBJECT",
          name: "PageHero",
        },
        { fields: [], interfaces: [], kind: "OBJECT", name: "RootQuery" },
      ],
    },
  },
};

describe(isFresh, () => {
  it("expires the cache after the ttl", () => {
    expect(isFresh(1000, 1000 + 599_999, 600_000)).toBeTruthy();
    expect(isFresh(1000, 1000 + 600_001, 600_000)).toBeFalsy();
  });
});

describe(parsePostTypes, () => {
  it("keeps only REST-exposed types and lists enabled supports", () => {
    expect(parsePostTypes(typesResponse)).toStrictEqual([
      {
        name: "Pages",
        rest_base: "pages",
        supports: ["editor", "title"],
        taxonomies: ["category"],
      },
    ]);
  });
});

describe(summarizeSchema, () => {
  it("keeps content-node scalar and enum fields and ACF field-group types", () => {
    expect(summarizeSchema(schemaResponse)).toStrictEqual({
      acfTypes: [{ fields: ["heroHeading"], name: "PageHero" }],
      contentTypes: [
        { fields: ["databaseId", "status", "title"], name: "Page" },
      ],
    });
  });

  it("returns empty lists when introspection is unavailable", () => {
    expect(summarizeSchema({ errors: [{ message: "denied" }] })).toStrictEqual({
      acfTypes: [],
      contentTypes: [],
    });
  });

  it("returns no ACF types when no schema type implements the ACF field-group interface", () => {
    const withoutAcfTypes = {
      data: {
        __schema: {
          types: [
            {
              fields: [
                { name: "title", type: { kind: "SCALAR", name: "String" } },
              ],
              interfaces: [{ name: "ContentNode" }],
              kind: "OBJECT",
              name: "Page",
            },
          ],
        },
      },
    };

    expect(summarizeSchema(withoutAcfTypes)).toStrictEqual({
      acfTypes: [],
      contentTypes: [{ fields: ["title"], name: "Page" }],
    });
  });
});

describe(buildSiteDescription, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("combines the site root, post types, and the trimmed schema", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === "/graphql") {
        return Response.json(schemaResponse);
      }

      if (url.pathname === "/wp-json/wp/v2/types") {
        return Response.json(typesResponse);
      }

      return Response.json({
        name: "Example Site",
        url: "https://wordpress.example",
      });
    });

    const description = await buildSiteDescription(
      client,
      createWordPressTelemetry()
    );

    expect(description.site).toStrictEqual({
      name: "Example Site",
      url: "https://wordpress.example",
    });
    expect(description.postTypes).toHaveLength(1);
    expect(description.contentTypes[0]?.name).toBe("Page");
    expect(description.acfTypes[0]?.name).toBe("PageHero");
  });

  it("does not infer a writable REST base from GraphQL exposure", async () => {
    const newsSchemaResponse = {
      data: {
        __schema: {
          types: [
            {
              fields: [
                { name: "title", type: { kind: "SCALAR", name: "String" } },
              ],
              interfaces: [{ name: "ContentNode" }],
              kind: "OBJECT",
              name: "News",
            },
          ],
        },
      },
    };

    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === "/graphql") {
        return Response.json(newsSchemaResponse);
      }

      if (url.pathname === "/wp-json/wp/v2/types") {
        return Response.json(typesResponse);
      }

      return Response.json({
        name: "Example Site",
        url: "https://wordpress.example",
      });
    });

    const description = await buildSiteDescription(
      client,
      createWordPressTelemetry()
    );

    expect(description.contentTypes).toStrictEqual([
      { fields: ["title"], name: "News" },
    ]);
    expect(description.postTypes).toStrictEqual([
      {
        name: "Pages",
        rest_base: "pages",
        supports: ["editor", "title"],
        taxonomies: ["category"],
      },
    ]);
  });

  it("throws a fixed WordPressRequestError and drops the WordPress error text when the schema query returns GraphQL errors", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === "/graphql") {
        return Response.json({
          errors: [{ message: "raw upstream schema detail" }],
        });
      }

      if (url.pathname === "/wp-json/wp/v2/types") {
        return Response.json(typesResponse);
      }

      return Response.json({
        name: "Example Site",
        url: "https://wordpress.example",
      });
    });

    const description = buildSiteDescription(
      client,
      createWordPressTelemetry()
    );

    await expect(description).rejects.toBeInstanceOf(WordPressRequestError);
    await expect(description).rejects.not.toThrow(
      /raw upstream schema detail/u
    );
  });
});
