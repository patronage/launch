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

const collectionSchema = z.object({
  hidden: z.boolean().optional(),
  label: z.string(),
  slug: z.string(),
  supports: z.array(z.string()).catch([]),
  urlPattern: z.string().nullish(),
});

const fieldSchema = z.object({
  label: z.string().optional(),
  required: z.boolean().optional(),
  slug: z.string(),
  type: z.string(),
});

const collectionsSchema = z.object({ items: z.array(collectionSchema) });

const collectionWithFieldsSchema = z.object({
  item: collectionSchema.extend({ fields: z.array(fieldSchema).catch([]) }),
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
    emdashData(client, "/_emdash/api/schema/collections", telemetry).then(
      (data) => parsed(collectionsSchema, data, "collections").items
    ),
    emdashData(client, "/_emdash/api/taxonomies", telemetry)
      .then((data) => parsed(taxonomiesSchema, data, "taxonomies").taxonomies)
      .catch(() => []),
    emdashData(client, "/_emdash/api/auth/me", telemetry).then((data) =>
      parsed(meSchema, data, "user")
    ),
  ]);

  const visible = collections.filter((collection) => !collection.hidden);
  const described = visible.slice(0, DESCRIBED_COLLECTIONS);

  const withFields = await Promise.all(
    described.map(async (collection) => {
      const data = await emdashData(
        client,
        `/_emdash/api/schema/collections/${encodeURIComponent(collection.slug)}?includeFields=true`,
        telemetry
      );

      const { item } = parsed(collectionWithFieldsSchema, data, "collection");

      const entry: JsonObject = {
        fields: item.fields.map((field) => {
          const summary: JsonObject = { slug: field.slug, type: field.type };

          if (field.required) {
            summary.required = true;
          }

          return summary;
        }),
        label: item.label,
        slug: item.slug,
        supports: item.supports,
      };

      if (item.urlPattern) {
        entry.urlPattern = item.urlPattern;
      }

      return entry;
    })
  );

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
      .map((collection) => collection.slug);
  }

  return site;
};
