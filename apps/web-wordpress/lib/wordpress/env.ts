const TRAILING_SLASH = /\/$/u;

/** Server-only settings, read per request so Workers secrets work too. */
export const wordpressEnv = () => {
  const url = process.env.WORDPRESS_URL;

  if (!url) {
    throw new Error(
      "WORDPRESS_URL is not set. See apps/web-wordpress/.env.example."
    );
  }

  const origin = url.replace(TRAILING_SLASH, "");

  return {
    accessClientId: process.env.WORDPRESS_ACCESS_CLIENT_ID ?? "",
    accessClientSecret: process.env.WORDPRESS_ACCESS_CLIENT_SECRET ?? "",
    accessPreviewAudience: process.env.ACCESS_PREVIEW_AUD ?? "",
    accessProofSecret: process.env.WORDPRESS_ACCESS_PROOF_SECRET ?? "",
    accessTeamDomain: process.env.ACCESS_TEAM_DOMAIN ?? "",
    graphqlUrl: `${origin}/graphql`,
    origin,
    previewPassword: process.env.WORDPRESS_PREVIEW_PASSWORD ?? "",
    previewUser: process.env.WORDPRESS_PREVIEW_USER ?? "",
    secret: process.env.HEADLESS_SECRET ?? "",
  };
};
