/**
 * The component library is for signed-in EmDash users. EmDash's middleware
 * sets `locals.user` on public routes when the request carries a valid admin
 * session (made when the user signs in to /_emdash through Cloudflare Access).
 * Anyone else is sent to the admin sign-in, which brings them back here.
 */
import type { AstroGlobal } from "astro";

export const requireEmDashUser = (Astro: AstroGlobal): Response | undefined => {
  // The page differs per viewer, so no shared cache may keep it.
  Astro.response.headers.set("Cache-Control", "private, no-store");
  Astro.response.headers.set("X-Robots-Tag", "noindex");

  if (Astro.locals.user) {
    return undefined;
  }

  const login = new URL("/_emdash/admin/login", Astro.url);

  login.searchParams.set("redirect", Astro.url.pathname + Astro.url.search);

  return Astro.redirect(login.pathname + login.search, 302);
};
