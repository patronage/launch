import { defineMiddleware } from "astro:middleware";

/** The home page's sitemap URL as EmDash builds it from `/{slug}`. */
const HOME_LOC = /(?<origin><loc>[^<]*?)\/home<\/loc>/u;

const pointHomeAtRoot = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    return response;
  }

  const text = await response.text();

  return new Response(text.replace(HOME_LOC, "$<origin>/</loc>"), {
    headers: response.headers,
    status: response.status,
  });
};

/**
 * EmDash's sitemap lists the home page at /home, which redirects to /.
 * Point it at / so the sitemap holds no redirects.
 */
export const onRequest = defineMiddleware((context, next): Promise<Response> =>
  context.url.pathname === "/sitemap-pages.xml"
    ? next().then(pointHomeAtRoot)
    : next()
);
