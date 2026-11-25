/**
 * The component library is for signed-in EmDash users. EmDash's middleware
 * sets `locals.user` on public routes when the request carries a valid admin
 * session (made when the user signs in to /_emdash through Cloudflare Access).
 * Anyone else is sent to the admin sign-in, which brings them back here.
 */
import type { AstroGlobal } from "astro";

// The page differs per viewer, so no shared cache may keep it, and no index.
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

export const requireEmDashUser = (Astro: AstroGlobal): Response | undefined => {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    Astro.response.headers.set(name, value);
  }

  if (Astro.locals.user) {
    return undefined;
  }

  const login = new URL("/_emdash/admin/login", Astro.url);

  login.searchParams.set("redirect", Astro.url.pathname + Astro.url.search);

  // Astro.redirect() drops Astro.response.headers, so build the redirect here.
  return new Response(null, {
    headers: { ...PRIVATE_HEADERS, Location: login.pathname + login.search },
    status: 302,
  });
};
