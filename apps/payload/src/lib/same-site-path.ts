// A copy of apps/web-wordpress/lib/same-site-path.ts, which has the tests.

/**
 * The path, query and hash of `path` once a browser resolves it against
 * `origin`, or undefined when it would leave that origin. "//host", "/\host"
 * and control characters browsers strip resolve off-site and are refused. A
 * path that only resolves to "//host" after dot segments ("/a/..//host") stays
 * on this origin, so its leading slashes are collapsed: redirecting to the
 * bare "//host" would be protocol-relative and leave the site.
 */
export const sameSitePath = (
  path: string,
  origin: string
): string | undefined => {
  if (!path.startsWith("/") || !URL.canParse(path, origin)) {
    return undefined;
  }

  const target = new URL(path, origin);

  if (target.origin !== new URL(origin).origin) {
    return undefined;
  }

  return `${target.pathname.replace(/^\/+/u, "/")}${target.search}${target.hash}`;
};
