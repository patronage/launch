const TRAILING_SLASH = /\/$/u;

/** Server-only settings, read per request so Workers secrets work too. */
export const wordpressEnv = () => {
  const url = process.env.WORDPRESS_URL;

  if (!url) {
    throw new Error(
      "WORDPRESS_URL is not set. See apps/web-wordpress/.env.example."
    );
  }

  return {
    graphqlUrl: `${url.replace(TRAILING_SLASH, "")}/graphql`,
    previewPassword: process.env.WORDPRESS_PREVIEW_PASSWORD ?? "",
    previewUser: process.env.WORDPRESS_PREVIEW_USER ?? "",
    secret: process.env.HEADLESS_SECRET ?? "",
  };
};
