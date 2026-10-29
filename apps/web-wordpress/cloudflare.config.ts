import { bindings, defineConfig, defineWorker } from "cf/config";

// The cf CLI's typed Worker config, in place of wrangler.jsonc (see
// docs/spikes/02-vinext-on-workers.md). The account comes from CLOUDFLARE_ACCOUNT_ID.
export default defineConfig({
  worker: defineWorker({
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    compatibilityDate: "2026-10-29",
    // Also mirrors bindings onto process.env, which lib/wordpress/env.ts reads.
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "vinext/server/fetch-handler",
    env: {
      ASSETS: bindings.assets(),
      // Values come from the shell at deploy time (scripts/deploy.mjs) and
      // from .env.local in local dev. They are never written to this file.
      HEADLESS_SECRET: bindings.secret(),
      IMAGES: bindings.images(),
      // Created on first deploy by `cf deploy --provision`. Holds ISR pages
      // and fetch data, so a revalidation reaches every isolate.
      VINEXT_KV_CACHE: bindings.kv(),
      WORDPRESS_PREVIEW_PASSWORD: bindings.secret(),
      WORDPRESS_PREVIEW_USER: bindings.secret(),
      WORDPRESS_URL: bindings.text(
        process.env.WORDPRESS_URL ?? "http://localhost:8080"
      ),
    },
    name: process.env.WORKER_NAME ?? "launch-vinext-wordpress",
  }),
});
