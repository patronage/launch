import type { APIRoute } from "astro";

/**
 * Public form submissions, at a path Cloudflare Access does not cover. The
 * forms plugin posts to /_emdash/api/plugins/emdash-forms/submit, which Access
 * protects, so the middleware points forms here and this hands the request to
 * the plugin's public submit route.
 */
export const POST: APIRoute = ({ rewrite }) =>
  rewrite("/_emdash/api/plugins/emdash-forms/submit");
