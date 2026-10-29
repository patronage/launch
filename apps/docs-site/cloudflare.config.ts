import { defineConfig, defineWorker } from "cf/config";

// Optional custom domain, e.g. launch-docs.example.org; the zone must be on the
// Cloudflare account, and a production deploy attaches it. blume.config.ts
// reads the same variable for the site's canonical URL. With
// WORKER_DOMAIN_PREVIEWS=true each Preview is also served at
// <preview>.<domain>, which a Free plan's Universal SSL certificate may not
// cover, so this is off by default. Previews always get a workers.dev URL.
const domain = process.env.WORKER_DOMAIN;
const previewsOnDomain = process.env.WORKER_DOMAIN_PREVIEWS === "true";

// This file is the cf CLI's typed Worker config. It replaces wrangler.jsonc:
// there is no Wrangler in this app. The account comes from CLOUDFLARE_ACCOUNT_ID.
//
// The site is static, so the Worker is assets only: no entrypoint and no
// bindings. scripts/build-output.mjs turns Blume's dist/ into its assets.
export default defineConfig({
  worker: defineWorker({
    assets: {
      // Blume writes each page as <route>/index.html and links to it without
      // a trailing slash; the default (auto-trailing-slash) would answer
      // /getting-started with a redirect to /getting-started/.
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
    },
    compatibilityDate: "2026-10-29",
    domains: domain
      ? [{ hostname: domain, previews: previewsOnDomain, production: true }]
      : [],
    name: process.env.WORKER_NAME ?? "launch-docs",
    previewUrls: true,
    workersDev: true,
  }),
});
