import type {
  JsonObject,
  JsonValue,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { emdashData } from "./emdash";

// How many collections `describe_site` lists with their fields. A site with
// more lists the rest by slug alone; emdash.get reads any one in full.
export const DESCRIBED_COLLECTIONS = 25;

const fieldSchema = z.object({
  kind: z.string().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
});

// EmDash's admin manifest, which any signed-in user may read. The schema
// routes need an editor's `schema:read`, which an author doesn't have.
const manifestSchema = z.object({
  collections: z.record(
    z.string(),
    z.object({
      fields: z.record(z.string(), fieldSchema.catch({})).catch({}),
      hidden: z.boolean().optional(),
      label: z.string(),
      supports: z.array(z.string()).catch([]),
      urlPattern: z.string().nullish(),
    })
  ),
});

const taxonomiesSchema = z.object({
  taxonomies: z
    .array(
      z.object({
        collections: z.array(z.string()).catch([]),
        hierarchical: z.boolean().optional(),
        label: z.string().optional(),
        name: z.string(),
      })
    )
    .catch([]),
});

const meSchema = z.object({ name: z.string().nullish(), role: z.number() });

// EmDash's role levels, named as its admin names them.
const ROLE_NAMES = new Map([
  [10, "subscriber"],
  [20, "contributor"],
  [30, "author"],
  [40, "editor"],
  [50, "admin"],
]);

const parsed = <T>(schema: z.ZodType<T>, value: JsonValue, what: string): T => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new Error(`EmDash returned an unexpected ${what} response`);
  }

  return result.data;
};

/**
 * The `emdash` part of `describe_site`: the collections the editor can see,
 * with their fields and what each supports (drafts, revisions, preview), the
 * taxonomies, and the editor's own role.
 */
export const describeEmDash = async (
  client: UpstreamClient,
  telemetry: UpstreamTelemetry
) => {
  const [collections, taxonomies, me] = await Promise.all([
    emdashData(client, "/_emdash/api/manifest", telemetry).then((data) =>
      Object.entries(parsed(manifestSchema, data, "manifest").collections)
    ),
    emdashData(client, "/_emdash/api/taxonomies", telemetry)
      .then((data) => parsed(taxonomiesSchema, data, "taxonomies").taxonomies)
      .catch(() => []),
    emdashData(client, "/_emdash/api/auth/me", telemetry).then((data) =>
      parsed(meSchema, data, "user")
    ),
  ]);

  const visible = collections.filter(([, collection]) => !collection.hidden);
  const described = visible.slice(0, DESCRIBED_COLLECTIONS);

  const withFields = described.map(([slug, collection]) => {
    const entry: JsonObject = {
      fields: Object.entries(collection.fields).map(([field, descriptor]) => {
        const summary: JsonObject = {
          slug: field,
          type: descriptor.type ?? descriptor.kind ?? "unknown",
        };

        if (descriptor.required) {
          summary.required = true;
        }

        return summary;
      }),
      label: collection.label,
      slug,
      supports: collection.supports,
    };

    if (collection.urlPattern) {
      entry.urlPattern = collection.urlPattern;
    }

    return entry;
  });

  const site: JsonObject = {
    collections: withFields,
    taxonomies: taxonomies.map((taxonomy) => {
      const summary: JsonObject = {
        collections: taxonomy.collections,
        name: taxonomy.name,
      };

      if (taxonomy.hierarchical) {
        summary.hierarchical = true;
      }

      return summary;
    }),
    user: { role: ROLE_NAMES.get(me.role) ?? String(me.role) },
  };

  if (visible.length > described.length) {
    site.moreCollections = visible
      .slice(DESCRIBED_COLLECTIONS)
      .map(([slug]) => slug);
  }

  return site;
};
