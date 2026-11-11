import type { Page, Redirect } from "@/payload-types";

import { postPath } from "./posts";
import { sameSitePath } from "./same-site-path";

/** A placeholder origin, for checks where only the path matters. */
const ANY_ORIGIN = "https://site.invalid";

/**
 * The `from` values that match a request path. The route has dropped any
 * trailing slash and decoded the path, while a redirect imported from another
 * site usually keeps its slash and may be percent-encoded.
 */
export const fromCandidates = (path: string): string[] => {
  const encoded = encodeURI(path);

  return [...new Set([path, `${path}/`, encoded, `${encoded}/`])];
};

/** Why `from` can't match a request path, or undefined when it can. */
export const fromPathError = (from: string): string | undefined => {
  if (!from.startsWith("/") || from.startsWith("//")) {
    return "Enter a path on this site that starts with one /, such as /old-page.";
  }

  return /[?#]/u.test(from)
    ? "Enter the path only. Redirects match without the query string or #anchor."
    : undefined;
};

/** Why `url` isn't a safe redirect destination, or undefined when it is. */
export const destinationUrlError = (url: string): string | undefined => {
  if (url.startsWith("/")) {
    return sameSitePath(url, ANY_ORIGIN) === undefined
      ? "Enter a path on this site or a full http(s) URL."
      : undefined;
  }

  return URL.canParse(url) && /^https?:$/u.test(new URL(url).protocol)
    ? undefined
    : "Enter a path on this site or a full http(s) URL.";
};

/**
 * Where a redirect goes, or undefined when it has nowhere to go. It was read
 * as an anonymous visitor, so a reference to an unpublished or deleted
 * document stays an id instead of being populated.
 */
export const redirectTarget = (
  { to }: Pick<Redirect, "to">,
  pagePath: (page: Page) => string | undefined
): string | undefined => {
  if (to?.type === "custom") {
    return to.url || undefined;
  }

  const reference = to?.reference;

  if (reference?.relationTo === "pages") {
    return reference.value instanceof Object
      ? pagePath(reference.value)
      : undefined;
  }

  return reference?.value instanceof Object
    ? postPath(reference.value)
    : undefined;
};

const pathIdentity = (url: URL): string =>
  `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;

/** Whether following `target` from `from` would land on the same path. */
export const isSelfRedirect = (
  target: string,
  from: string,
  origin: string
): boolean =>
  pathIdentity(new URL(target, origin)) === pathIdentity(new URL(from, origin));
