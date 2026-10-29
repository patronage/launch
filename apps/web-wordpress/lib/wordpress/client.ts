import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { print } from "graphql";

import { wordpressEnv } from "./env";

/** Every WordPress fetch carries this tag; the revalidate route purges it on publish. */
export const WORDPRESS_CACHE_TAG = "wordpress";

interface FetchOptions {
  /** Read as the preview user: drafts, private posts and unsaved changes. Never cached. */
  preview?: boolean;
}

interface GraphQLResponse<Result> {
  data?: Result;
  errors?: { message: string }[];
}

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
 * password and skip the cache.
 */
export const wpQuery = async <
  Result,
  Variables extends Record<string, unknown>,
>(
  document: TypedDocumentNode<Result, Variables>,
  variables: Variables,
  { preview = false }: FetchOptions = {}
): Promise<Result> => {
  const headers = new Headers({ "content-type": "application/json" });

  if (preview) {
    headers.set("authorization", previewAuthorization());
  }

  const response = await fetch(wordpressEnv().graphqlUrl, {
    body: JSON.stringify({ query: print(document), variables }),
    headers,
    method: "POST",
    ...(preview
      ? { cache: "no-store" }
      : { next: { tags: [WORDPRESS_CACHE_TAG] } }),
  });

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
