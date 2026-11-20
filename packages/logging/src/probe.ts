// The probe guard: a plain 404 at the Worker entry for paths no Launch site
// serves (`/.env`, `/wp-login.php`, `/cgi-bin/…`), so the framework's router,
// its not-found page and any CMS read never run for them. This module has no
// dependencies, so a site can import it without evlog.

/** Anything with a Workers `fetch` handler, such as vinext's worker entry. */
export interface ProbeGuardEntry {
  fetch: (request: Request, ...rest: never[]) => Promise<Response> | Response;
}

export interface ProbeGuardOptions {
  /**
   * Paths the site does serve. A path equal to one of these, or under one
   * that ends in `/`, is never treated as a probe. Compared without case.
   */
  allow?: string[];
  /**
   * More paths to answer with a 404. A path equal to one of these, or under
   * one that ends in `/`, is a probe. Compared without case.
   */
  extra?: string[];
}

/**
 * Path segments, anywhere in the path, that only ever come from scanners:
 * version control, secrets and editor folders. `/.well-known/` is not here
 * and is never matched.
 */
const PROBE_SEGMENTS = new Set([
  ".aws",
  ".bzr",
  ".circleci",
  ".docker",
  ".ds_store",
  ".git",
  ".hg",
  ".htaccess",
  ".htpasswd",
  ".idea",
  ".npmrc",
  ".ssh",
  ".svn",
  ".vscode",
  "cgi-bin",
]);

/** `.env`, `.env.local`, `.env.production.bak` and the like. */
const ENV_SEGMENT = /^\.env(?:\..*)?$/u;

/**
 * Server-side script extensions no Launch site serves. Launch's front ends
 * are Workers, and the CMS sits on its own hostname behind Access.
 */
const PROBE_EXTENSION = /\.(?:asp|aspx|cgi|jsp|php\d?|phtml)$/u;

const decode = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

const normalize = (pathname: string): string => decode(pathname).toLowerCase();

const covers = (list: string[], path: string): boolean =>
  list.some((entry) => {
    const prefix = entry.toLowerCase();

    return prefix.endsWith("/")
      ? path === prefix.slice(0, -1) || path.startsWith(prefix)
      : path === prefix;
  });

const onDefaultList = (path: string): boolean => {
  const segments = path.split("/").filter(Boolean);

  // Any segment, so `/index.php/wp-json` style path info matches too.
  return segments.some(
    (s) =>
      PROBE_SEGMENTS.has(s) || ENV_SEGMENT.test(s) || PROBE_EXTENSION.test(s)
  );
};

/**
 * True when `pathname` is on Launch's shared list of scanner paths, or on
 * `options.extra`, and not on `options.allow`. Percent-encoding and case are
 * ignored, so `/%2Eenv` and `/WP-LOGIN.PHP` match too.
 */
export const isProbePath = (
  pathname: string,
  options: ProbeGuardOptions = {}
): boolean => {
  const path = normalize(pathname);

  if (options.allow && covers(options.allow, path)) {
    return false;
  }

  return (
    onDefaultList(path) || (options.extra ? covers(options.extra, path) : false)
  );
};

// Responses the guard made, so withRequestLog can mark the event without a
// header going out to the client.
const guarded = new WeakSet<Response>();

/** True for a response that {@link withProbeGuard} answered. */
export const isProbeResponse = (response: Response): boolean =>
  guarded.has(response);

const probeResponse = (): Response => {
  const response = new Response(null, {
    headers: { "cache-control": "public, max-age=3600" },
    status: 404,
  });

  guarded.add(response);

  return response;
};

/**
 * Wrap a Worker's fetch entry so a request for a probe path gets an empty 404
 * without calling the entry. Put it inside `withRequestLog`, so a guarded
 * request is still one event, marked `probe: true`. Other handlers on the
 * entry, such as scheduled or queue, are kept.
 */
export const withProbeGuard = <TEntry extends ProbeGuardEntry>(
  entry: TEntry,
  options: ProbeGuardOptions = {}
): TEntry => {
  const fetch = (request: Request, ...rest: never[]) =>
    isProbePath(new URL(request.url).pathname, options)
      ? probeResponse()
      : entry.fetch(request, ...rest);

  return { ...entry, fetch };
};
