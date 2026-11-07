import { UpstreamRequestError } from "@patronage/mcp-core";
import type {
  JsonValue,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { wordPressErrorMessage, wpFetch, wpGraphql } from "./wordpress";

const MAX_CONTENT_TYPES = 40;
const MAX_FIELDS = 60;
const CONTENT_NODE_INTERFACE = "ContentNode";

// This is the interface name WPGraphQL ACF gives every field-group type as of
// writing. If a consumer schema uses a different name, no type will carry it
// and acfTypes will simply come back empty. summarizeSchema treats an absent
// interface as "no ACF types" rather than an error.
const ACF_GROUP_INTERFACE = "AcfFieldGroup";

// Fixed and generic on purpose: WordPress's GraphQL error text can carry
// upstream implementation detail, so it is never forwarded to the caller.
const SCHEMA_INTROSPECTION_ERROR_MESSAGE =
  "WordPress GraphQL schema introspection failed.";

export const SCHEMA_QUERY = `query LaunchMcpSchema {
  __schema {
    types {
      kind
      name
      interfaces { name }
      fields {
        name
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }
}`;

export interface PostTypeSummary {
  name: string;
  rest_base: string;
  supports: string[];
  taxonomies: string[];
}

export interface GraphqlTypeSummary {
  fields: string[];
  name: string;
}

export interface WordPressDescription {
  acfTypes: GraphqlTypeSummary[];
  // GraphQL exposure is independent of REST exposure. A content type can be
  // readable here while having no writable route; `postTypes` is the
  // authoritative inventory for `wp.apply` rest_base values.
  contentTypes: GraphqlTypeSummary[];
  postTypes: PostTypeSummary[];
  site: { name: string; url: string };
}

// Named so `summarizeSchema`'s return type is an owner contract rather than
// an anonymous object type (anti-slop/no-known-value-widening).
interface SchemaSummary {
  acfTypes: GraphqlTypeSummary[];
  contentTypes: GraphqlTypeSummary[];
}

// The introspection payload nests a field's type through NON_NULL/LIST
// wrappers via `ofType` before reaching the named SCALAR/ENUM/OBJECT kind.
// This recursive shape lets `unwrapKind` walk that chain without a cast.
interface GraphqlNamedType {
  kind?: string | undefined;
  name?: string | null | undefined;
  ofType?: GraphqlNamedType | null | undefined;
}

const postTypeSchema = z.object({
  name: z.string(),
  rest_base: z.string().min(1),
  supports: z.record(z.string(), z.boolean()).optional(),
  taxonomies: z.array(z.string()).optional(),
});

const namedTypeSchema: z.ZodType<GraphqlNamedType> = z.object({
  kind: z.string().optional(),
  name: z.string().nullable().optional(),
  ofType: z
    .lazy(() => namedTypeSchema)
    .nullable()
    .optional(),
});

const schemaTypeSchema = z.object({
  fields: z
    .array(z.object({ name: z.string(), type: namedTypeSchema }))
    .nullable()
    .optional(),
  interfaces: z
    .array(z.object({ name: z.string().nullable() }))
    .nullable()
    .optional(),
  kind: z.string(),
  name: z.string(),
});

const introspectionSchema = z.object({
  data: z.object({
    __schema: z.object({ types: z.array(schemaTypeSchema) }),
  }),
});

const graphqlErrorsSchema = z.object({
  errors: z.array(z.json()).min(1),
});

const siteRootSchema = z.object({ name: z.string(), url: z.string() });

export const parsePostTypes = (value: JsonValue): PostTypeSummary[] => {
  const record = z.record(z.string(), z.json()).safeParse(value);

  if (!record.success) {
    return [];
  }

  const summaries: PostTypeSummary[] = [];

  for (const entry of Object.values(record.data)) {
    const parsed = postTypeSchema.safeParse(entry);

    if (!parsed.success) {
      continue;
    }

    summaries.push({
      name: parsed.data.name,
      rest_base: parsed.data.rest_base,
      supports: Object.entries(parsed.data.supports ?? {})
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
        .toSorted(),
      taxonomies: parsed.data.taxonomies ?? [],
    });
  }

  return summaries;
};

const unwrapKind = (type: GraphqlNamedType): string =>
  type.ofType ? unwrapKind(type.ofType) : (type.kind ?? "");

const hasInterface = (
  interfaces: { name: string | null }[] | null | undefined,
  target: string
): boolean => (interfaces ?? []).some((entry) => entry.name === target);

const hasGraphqlErrors = (value: JsonValue): boolean =>
  graphqlErrorsSchema.safeParse(value).success;

export const summarizeSchema = (value: JsonValue): SchemaSummary => {
  const parsed = introspectionSchema.safeParse(value);

  if (!parsed.success) {
    return { acfTypes: [], contentTypes: [] };
  }

  const acfTypes: GraphqlTypeSummary[] = [];
  const contentTypes: GraphqlTypeSummary[] = [];

  for (const type of parsed.data.data.__schema.types) {
    if (type.kind !== "OBJECT") {
      continue;
    }

    const fields = type.fields ?? [];

    if (hasInterface(type.interfaces, ACF_GROUP_INTERFACE)) {
      acfTypes.push({
        fields: fields
          .map((field) => field.name)
          .toSorted()
          .slice(0, MAX_FIELDS),
        name: type.name,
      });
      continue;
    }

    if (!hasInterface(type.interfaces, CONTENT_NODE_INTERFACE)) {
      continue;
    }

    contentTypes.push({
      fields: fields
        .filter((field) => {
          const kind = unwrapKind(field.type);

          return kind === "SCALAR" || kind === "ENUM";
        })
        .map((field) => field.name)
        .toSorted()
        .slice(0, MAX_FIELDS),
      name: type.name,
    });
  }

  return {
    acfTypes,
    contentTypes: contentTypes.slice(0, MAX_CONTENT_TYPES),
  };
};

export const buildSiteDescription = async (
  client: UpstreamClient,
  telemetry: UpstreamTelemetry
): Promise<WordPressDescription> => {
  const root = await wpFetch(client, "/wp-json/", telemetry);

  const types = await wpFetch(
    client,
    "/wp-json/wp/v2/types?context=edit",
    telemetry
  );

  // `wpFetch` hands back any status. An error body here would read as a site
  // with no content types, and be cached as one.
  for (const response of [root, types]) {
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamRequestError(
        wordPressErrorMessage(response.status, response.errorCode) ??
          `WordPress returned HTTP ${response.status}`
      );
    }
  }

  const schema = await wpGraphql(client, SCHEMA_QUERY, undefined, telemetry);

  if (hasGraphqlErrors(schema)) {
    throw new UpstreamRequestError(SCHEMA_INTROSPECTION_ERROR_MESSAGE);
  }

  const site = siteRootSchema.safeParse(root.json);

  return {
    ...summarizeSchema(schema),
    postTypes: parsePostTypes(types.json),
    site: site.success
      ? { name: site.data.name, url: site.data.url }
      : { name: "unknown", url: client.apiUrl },
  };
};
