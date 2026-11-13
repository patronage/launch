import { parseCookies } from "payload";

// Logging out of the admin when Cloudflare Access signs editors in, the way
// WordPress's patronage-access plugin does it.
//
// Logging out ends the Payload session but leaves the Access session alone.
// Without more, the next request would carry the Access JWT and the Access
// strategy (collections/users.ts) would sign the editor straight back in. So
// logout also sets a short-lived opt-out cookie, and while the browser holds
// it the Access strategy steps aside: the admin shows Payload's login form,
// where the editor can sign in with a password or choose "Sign in with Access" to sign
// in through Access again (which clears the cookie).
//
// The cookie can only make the Access strategy step aside. It never signs
// anyone in, so an expired, missing or forged one does no harm.

/** How long the opt-out lasts. After it, Access signs the editor in again. */
export const ACCESS_OPT_OUT_SECONDS = 60 * 60;

/** The route the login page's "Sign in with Access" button posts to. */
export const ACCESS_SIGN_IN_PATH = "/next/access-sign-in";

interface AccessSettings {
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

/** Whether the Access strategy signs editors in: both settings are set. */
export const accessSignInEnabled = ({
  ACCESS_AUD,
  ACCESS_TEAM_DOMAIN,
}: AccessSettings): boolean => Boolean(ACCESS_TEAM_DOMAIN && ACCESS_AUD);

const cookieName = (cookiePrefix: string) => `${cookiePrefix}-access-off`;

/** Whether the browser asked the Access strategy to step aside. */
export const accessOptedOut = (
  headers: Headers,
  cookiePrefix: string
): boolean => parseCookies(headers).has(cookieName(cookiePrefix));

interface CookieOptions {
  cookiePrefix: string;
  /** Add `Secure`: the request came over HTTPS. */
  secure: boolean;
}

const cookie = (
  { cookiePrefix, secure }: CookieOptions,
  value: string,
  maxAge: number
) =>
  [
    `${cookieName(cookiePrefix)}=${value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

/** The Set-Cookie value logout sends. */
export const accessOptOutCookie = (options: CookieOptions): string =>
  cookie(options, "1", ACCESS_OPT_OUT_SECONDS);

/** The Set-Cookie value that ends the opt-out. */
export const clearAccessOptOutCookie = (options: CookieOptions): string =>
  cookie(options, "", 0);

/** Whether a request URL is HTTPS, so its cookies should be `Secure`. */
export const isHttps = (url: string | undefined): boolean =>
  url?.startsWith("https:") ?? false;

/**
 * Whether a POST came from this site's own pages. Fetch Metadata answers when
 * the browser sends it; otherwise the Origin, then the Referer, must match
 * `origin`. A request with none of them is refused, so another site cannot
 * undo a logout.
 */
export const isSameOriginPost = (headers: Headers, origin: string): boolean => {
  const site = headers.get("sec-fetch-site");

  if (site !== null) {
    return site === "same-origin";
  }

  const source = headers.get("origin") ?? headers.get("referer");

  return (
    source !== null && URL.canParse(source) && new URL(source).origin === origin
  );
};
