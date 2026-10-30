import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { ACCESS_ASSERTION_HEADER } from "@patronage/access";
import type { DocumentNode } from "graphql";
import { headers as incomingHeaders } from "next/headers";
import { z } from "zod";

import { wordpressEnv } from "./env";
import { wordpressFetch } from "./fetch";

/** Every WordPress fetch carries this tag; the revalidate route purges it on publish. */
export const WORDPRESS_CACHE_TAG = "wordpress";

interface FetchOptions {
  /**
   * Preview this post: read as the preview user, with WPGraphQL's preview
   * context so the post's latest unsaved changes overlay it. Never cached.
   */
  previewDatabaseId?: number;
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

/**
 * Runs a typed WPGraphQL query. Public reads go through the fetch cache under
 * WORDPRESS_CACHE_TAG; preview reads authenticate with the application
 * password, send the X-GraphQL-Preview header and skip the cache.
 */
export const wpQuery = async <
  Result,
  Variables extends Record<string, unknown>,
>(
  document: TypedDocumentNode<Result, Variables>,
  variables: Variables,
  { previewDatabaseId }: FetchOptions = {}
): Promise<Result> => {
  const headers = new Headers({ "content-type": "application/json" });

  const preview = previewDatabaseId !== undefined;

  if (preview) {
    headers.set("authorization", previewAuthorization());
    // WPGraphQL 2's request-level preview context; it replaces the deprecated asPreview argument.
    headers.set("x-graphql-preview", `database_id=${previewDatabaseId}`);
  }

  let previewJwt: string | null | undefined;

  if (preview) {
    const requestHeaders = await incomingHeaders();

    previewJwt = requestHeaders.get(ACCESS_ASSERTION_HEADER);
  }

  const response = await wordpressFetch(
    wordpressEnv().graphqlUrl,
    {
      body: JSON.stringify({ queryId: queryId(document), variables }),
      headers,
      method: "POST",
      ...(preview
        ? { cache: "no-store" }
        : { next: { tags: [WORDPRESS_CACHE_TAG] } }),
    },
    previewJwt
  );

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
