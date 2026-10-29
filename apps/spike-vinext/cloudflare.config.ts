import { bindings, defineConfig, defineWorker } from "cf/config";

// Optional custom domain, e.g. launch-wordpress.example.org; the zone must be
// on the Cloudflare account, and a production deploy attaches it. With
// WORKER_DOMAIN_PREVIEWS=true each Preview is also served at
// <preview>.<domain>. Those hostnames are two levels below the zone, which a
// Free plan's Universal SSL certificate may not cover, so this is off by
// default. Previews always get a workers.dev URL.
const domain = process.env.WORKER_DOMAIN;
const previewsOnDomain = process.env.WORKER_DOMAIN_PREVIEWS === "true";

// This file is the cf CLI's typed Worker config. It replaces wrangler.jsonc:
// there is no Wrangler in this app. The account comes from CLOUDFLARE_ACCOUNT_ID.
export default defineConfig({
  worker: defineWorker({
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    compatibilityDate: "2026-10-29",
    compatibilityFlags: ["nodejs_compat"],
    domains: domain
      ? [{ hostname: domain, previews: previewsOnDomain, production: true }]
      : [],
    entrypoint: "vinext/server/fetch-handler",
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      // Values come from the shell at deploy time (scripts/deploy.mjs) and from
      // .env.local in local dev. They are never written to this file.
      PREVIEW_SECRET: bindings.secret(),
      REVALIDATE_SECRET: bindings.secret(),
      UPSTREAM_URL: bindings.text(
        process.env.UPSTREAM_URL ?? "https://httpbin.org/uuid"
      ),
      // Created on first deploy by `cf deploy --provision`.
      VINEXT_KV_CACHE: bindings.kv(),
    },
    name: process.env.WORKER_NAME ?? "launch-vinext-wordpress",
    // Serve production on workers.dev and Previews on
    // <preview>-<worker>.<subdomain>.workers.dev. A Worker created in the
    // dashboard can start with workers.dev off; a production deploy applies these.
    previewUrls: true,
    workersDev: true,
  }),
});
