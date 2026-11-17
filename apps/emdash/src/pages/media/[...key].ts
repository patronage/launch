import type { APIRoute } from "astro";

/**
 * Public media, at a path Cloudflare Access does not cover. Access protects
 * /_emdash/*, so this hands the request to EmDash's own file route, which
 * serves only media (never backups or staging) with its own cache headers.
 */
export const GET: APIRoute = ({ params, rewrite }) =>
  rewrite(`/_emdash/api/media/file/${params.key ?? ""}`);
