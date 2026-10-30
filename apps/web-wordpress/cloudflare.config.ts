import { bindings, defineConfig, defineWorker } from "cf/config";

// Optional custom domain (launch-wordpress.patronage.dev for the demo); the
// zone must be on the Cloudflare account, and a production deploy attaches it.
// With WORKER_DOMAIN_PREVIEWS=true each Preview is also served at
// <preview>.<domain>, which a Free plan's Universal SSL certificate may not
// cover, so it is off by default. Previews always get a workers.dev URL.
const domain = process.env.WORKER_DOMAIN;
const previewsOnDomain = process.env.WORKER_DOMAIN_PREVIEWS === "true";

// The cf CLI's typed Worker config, in place of wrangler.jsonc (see
// docs/spikes/02-vinext-on-workers.md). The account comes from CLOUDFLARE_ACCOUNT_ID.
export default defineConfig(({ isPreview }) => ({
  worker: defineWorker({
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    compatibilityDate: "2026-10-29",
    // Also mirrors bindings onto process.env, which lib/wordpress/env.ts reads.
    compatibilityFlags: ["nodejs_compat"],
    domains: domain
      ? [{ hostname: domain, previews: previewsOnDomain, production: true }]
      : [],
    entrypoint: "vinext/server/fetch-handler",
    env: {
      ASSETS: bindings.assets(),
      // Values come from the shell at deploy time (scripts/deploy.mjs) and
      // from .env.local in local dev. They are never written to this file.
      HEADLESS_SECRET: bindings.secret(),
      IMAGES: bindings.images(),
      // Production adopts the namespace created by the first deploy attempt.
      // Previews keep their existing configuration without this resource id.
      VINEXT_KV_CACHE: bindings.kv(
        isPreview ? {} : { id: "d5b43cfa9e444ac2b772c7b042d6c641" }
      ),
      WORDPRESS_PREVIEW_PASSWORD: bindings.secret(),
      WORDPRESS_PREVIEW_USER: bindings.secret(),
      WORDPRESS_URL: bindings.text(
        process.env.WORDPRESS_URL ?? "http://localhost:8080"
      ),
    },
    name: process.env.WORKER_NAME ?? "launch-vinext-wordpress",
    // Production on workers.dev and Previews on <preview>-<worker>.<subdomain>.workers.dev.
    // The dashboard created this Worker with workers.dev off; a production deploy applies these.
    previewUrls: true,
    workersDev: true,
  }),
}));
