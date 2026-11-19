/**
 * Every cached WordPress read carries this tag, so revalidating it expires
 * every read and every page. WordPress sends it when Smart Cache purges
 * everything (a settings change, "Purge Cache Now").
 */
export const WORDPRESS_CACHE_TAG = "wordpress";

const PATH_TAG_PREFIX = "path:";
const TRAILING_SLASHES = /\/+$/u;
const PERCENT_ESCAPE = /%[\da-f]{2}/giu;
const QUERY_HASH = /^[\da-f]{64}$/u;
const WHITESPACE = /\s+/u;

/**
 * Keys every response carries (the query hash, graphql:Query and
 * operation:<name>) would turn any purge into a purge of everything, so only
 * node keys (global IDs), list:<type> and skipped:<type> become tags.
 */
const isNodeOrListKey = (key: string): boolean =>
  key.length > 0 &&
  key !== "graphql:Query" &&
  !key.startsWith("operation:") &&
  !QUERY_HASH.test(key);

/**
 * The cache tags for a WPGraphQL response: the WPGraphQL Smart Cache keys in
 * its X-GraphQL-Keys header that WordPress purges when the posts, terms,
 * menus or settings behind them change.
 */
export const smartCacheTags = (header: string | null): string[] => [
  ...new Set((header ?? "").split(WHITESPACE).filter(isNodeOrListKey)),
];

/**
 * The tag for a front-end path, on the content read of that path. A path with
 * nothing published at it has no node keys, so this tag is what replaces its
 * cached "not found" when a post is published there. Trailing slashes are
 * dropped, so /about/ (a WordPress URI) and /about (what WordPress sends) match,
 * and percent escapes are uppercased: WordPress writes them in lowercase,
 * encodeURIComponent in uppercase.
 */
export const pathTag = (path: string): string =>
  `${PATH_TAG_PREFIX}${
    path
      .replaceAll(PERCENT_ESCAPE, (escape) => escape.toUpperCase())
      .replace(TRAILING_SLASHES, "") || "/"
  }`;
