import { UpstreamRequestError } from "@patronage/mcp-core";
import { z } from "zod";

import { EMDASH_API_PREFIX } from "./emdash";

// The EmDash REST routes `emdash.get` may read, as patterns over the path
// after /_emdash/api/. Everything else is refused, the admin's own routes
// included: users, API and OAuth tokens, settings, plugins, imports and
// exports, and the content routes that take or report an edit lock.
const SEGMENT = "[A-Za-z0-9_-]+";

const READABLE_ROUTES: readonly RegExp[] = [
  "content/*",
  "content/*/trash",
  "content/*/*",
  "content/*/*/compare",
  "content/*/*/revisions",
  "content/*/*/translations",
  "content/*/*/terms/*",
  "content/*/*/references/*/(?:children|parents)",
  "revisions/*",
  "schema/collections",
  "schema/collections/*",
  "schema/block-types",
  "schema/block-types/*",
  "media",
  "media/*",
  "media/*/usage",
  "menus",
  "menus/*",
  "taxonomies",
  "taxonomies/*",
  "taxonomies/*/terms",
  "taxonomies/*/terms/*",
  "search",
  "search/suggest",
].map((route) => new RegExp(`^${route.replaceAll("*", SEGMENT)}$`, "u"));

// `content/{collection}/{id}` would also match the route that lists a
// collection's authors, which reads the site's users, so that name is
// refused in the id's place.
const RESERVED_CONTENT_SEGMENTS = new Set(["authors"]);

// Query values are rendered with `String(value)`, so only scalars.
export const readQuerySchema = z.record(
  z.string().min(1),
  z.union([z.boolean(), z.number(), z.string()])
);

export const readArgsSchema = z.object({
  path: z.string().min(1),
  query: readQuerySchema.optional(),
});

export type ReadArgs = z.infer<typeof readArgsSchema>;

/**
 * Checks a path `emdash.get` was given and returns it with its query string.
 * Throws `UpstreamRequestError` with a message the model can act on.
 */
export const readablePath = (args: ReadArgs): string => {
  const { path, query } = args;

  if (path.includes("?") || path.includes("#")) {
    throw new UpstreamRequestError(
      "emdash.get path must not contain a query string; pass parameters in the query argument"
    );
  }

  if (!path.startsWith(EMDASH_API_PREFIX)) {
    throw new UpstreamRequestError(
      `emdash.get path must start with ${EMDASH_API_PREFIX}`
    );
  }

  const route = path.slice(EMDASH_API_PREFIX.length).replace(/\/$/u, "");
  const segments = route.split("/");

  if (
    !READABLE_ROUTES.some((pattern) => pattern.test(route)) ||
    (segments[0] === "content" &&
      segments.length === 3 &&
      RESERVED_CONTENT_SEGMENTS.has(segments[2] ?? ""))
  ) {
    throw new UpstreamRequestError(
      `emdash.get cannot read ${path}. It reads content, revisions, schema, media, menus, taxonomies and search under ${EMDASH_API_PREFIX}`
    );
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    params.set(key, String(value));
  }

  const encoded = params.toString();

  return `${EMDASH_API_PREFIX}${route}${encoded ? `?${encoded}` : ""}`;
};
