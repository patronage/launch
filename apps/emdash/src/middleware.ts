import { defineMiddleware } from "astro:middleware";

/** The home page's sitemap URL as EmDash builds it from `/{slug}`. */
const HOME_LOC = /(?<origin><loc>[^<]*?)\/home<\/loc>/u;

/**
 * Cloudflare Access protects /_emdash/*. Public pages and sitemaps must not
 * point visitors or scrapers there, so these move to the public routes in
 * src/pages/media and src/pages/forms.
 */
const MEDIA_PATH = /\/_emdash\/api\/media\/file\//gu;
const SUBMIT_PATH = /\/_emdash\/api\/plugins\/emdash-forms\/submit/gu;

const toPublicPaths = (text: string): string =>
  text
    .replaceAll(MEDIA_PATH, "/media/")
    .replaceAll(SUBMIT_PATH, "/forms/submit");

const rewriteBody =
  (edit: (text: string) => string) =>
  async (response: Response): Promise<Response> => {
    if (!response.ok) {
      return response;
    }

    const text = await response.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");

    return new Response(edit(text), { headers, status: response.status });
  };

const isHtml = (response: Response): boolean =>
  response.headers.get("content-type")?.includes("text/html") ?? false;

const publicPage = (response: Response): Promise<Response> =>
  isHtml(response)
    ? rewriteBody(toPublicPaths)(response)
    : Promise.resolve(response);

/**
 * EmDash's sitemap lists the home page at /home, which redirects to /.
 * Point it at / so the sitemap holds no redirects.
 */
const sitemapPages = rewriteBody((text) =>
  toPublicPaths(text).replace(HOME_LOC, "$<origin>/</loc>")
);

export const onRequest = defineMiddleware(
  (context, next): Promise<Response> => {
    const { pathname } = context.url;

    if (pathname.startsWith("/_emdash")) {
      return next();
    }

    if (pathname.startsWith("/sitemap")) {
      return next().then(
        pathname === "/sitemap-pages.xml"
          ? sitemapPages
          : rewriteBody(toPublicPaths)
      );
    }

    return next().then(publicPage);
  }
);
