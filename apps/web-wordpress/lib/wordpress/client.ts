import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { ACCESS_ASSERTION_HEADER } from "@patronage/access";
import type { DocumentNode } from "graphql";
import { cacheLife, cacheTag } from "next/cache";
import { headers as incomingHeaders } from "next/headers";
import { z } from "zod";

import { smartCacheTags, WORDPRESS_CACHE_TAG } from "./cache-tags";
import { wordpressEnv } from "./env";
import { wordpressFetch } from "./fetch";

interface FetchOptions {
  /**
   * Preview this post: read as the preview user, with WPGraphQL's preview
   * context so the post's latest unsaved changes overlay it. Never cached.
   */
  previewDatabaseId?: number;
  /** Tags for the cached read besides its Smart Cache keys, such as pathTag(). */
  tags?: string[];
}

interface GraphQLResponse<Result> {
  data?: Result;
  errors?: { message: string }[];
}

/**
 * WordPress runs only registered queries (persisted queries in Smart Cache's
 * "only allowed" mode), so requests carry the query ID alone. Codegen puts
 * the SHA-256 of each operation in its document; scripts/documents.ts
 * registers the same IDs with WordPress.
 */
const PersistedDocument = z.object({
  __meta__: z.object({ hash: z.string() }),
});

const queryId = (document: DocumentNode): string => {
  const parsed = PersistedDocument.safeParse(document);

  if (!parsed.success) {
    throw new TypeError(
      "GraphQL document has no persisted query hash; run `pnpm codegen`."
    );
  }

  return parsed.data.__meta__.hash.replace(/^sha256:/u, "");
};

const previewAuthorization = (): string => {
  const { previewUser, previewPassword } = wordpressEnv();

  if (!(previewUser && previewPassword)) {
    throw new Error(
      "Preview needs WORDPRESS_PREVIEW_USER and WORDPRESS_PREVIEW_PASSWORD."
    );
  }

  return `Basic ${btoa(`${previewUser}:${previewPassword}`)}`;
};

/** Throws on an HTTP or GraphQL error, so an error is never cached. */
const readData = async <Result>(response: Response): Promise<Result> => {
  if (!response.ok) {
    throw new Error(
      `WPGraphQL answered ${response.status} ${response.statusText}`
    );
  }

  // SAFETY: WPGraphQL always answers {data, errors}; data matches the typed
  // document because codegen validated it against the same schema.
  const body = (await response.json()) as GraphQLResponse<Result>;

  if (body.errors?.length) {
    throw new Error(
      `WPGraphQL: ${body.errors.map((error) => error.message).join("; ")}`
    );
  }

  if (!body.data) {
    throw new Error("WPGraphQL returned no data");
  }

  return body.data;
};

// Pages revalidate hourly as a safety net for a missed purge; so does the data.
const WORDPRESS_CACHE_LIFE = { expire: 86_400, revalidate: 3600 };

/**
 * A public read, cached in the data cache per query ID and variables (as
 * JSON, so the cache key is a plain string). It is
 * tagged with WORDPRESS_CACHE_TAG, the WPGraphQL Smart Cache keys of the
 * response and any extra tags; a page that renders it carries the same tags,
 * so a purge of one post's key expires every read and page that showed it.
 */
const cachedQuery = async (
  id: string,
  variablesJson: string,
  tags: string[]
): Promise<{ data: unknown }> => {
  "use cache";
  cacheLife(WORDPRESS_CACHE_LIFE);

  const response = await wordpressFetch(wordpressEnv().graphqlUrl, {
    body: `{"queryId":${JSON.stringify(id)},"variables":${variablesJson}}`,
    cache: "no-store",
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const data = await readData(response);

  cacheTag(
    WORDPRESS_CACHE_TAG,
    ...tags,
    ...smartCacheTags(response.headers.get("x-graphql-keys"))
  );

  return { data };
};

/**
 * Runs a typed WPGraphQL query. Public reads go through cachedQuery; preview
 * reads authenticate with the application password, send the
 * X-GraphQL-Preview header and skip the cache.
 */
export const wpQuery = async <
  Result,
  Variables extends Record<string, unknown>,
>(
  document: TypedDocumentNode<Result, Variables>,
  variables: Variables,
  { previewDatabaseId, tags = [] }: FetchOptions = {}
): Promise<Result> => {
  if (previewDatabaseId === undefined) {
    const { data } = await cachedQuery(
      queryId(document),
      JSON.stringify(variables),
      tags
    );

    // SAFETY: cachedQuery returns the data of this document's query.
    return data as Result;
  }

  const headers = new Headers({
    authorization: previewAuthorization(),
    "content-type": "application/json",
    // WPGraphQL 2's request-level preview context; it replaces the deprecated asPreview argument.
    "x-graphql-preview": `database_id=${previewDatabaseId}`,
  });

  const requestHeaders = await incomingHeaders();

  const response = await wordpressFetch(
    wordpressEnv().graphqlUrl,
    {
      body: JSON.stringify({ queryId: queryId(document), variables }),
      cache: "no-store",
      headers,
      method: "POST",
    },
    requestHeaders.get(ACCESS_ASSERTION_HEADER)
  );

  return readData<Result>(response);
};
