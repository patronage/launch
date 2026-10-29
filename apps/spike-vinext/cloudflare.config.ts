import { bindings, defineConfig, defineWorker } from "cf/config";

// This file is the cf CLI's typed Worker config. It replaces wrangler.jsonc:
// there is no Wrangler in this app. The account comes from CLOUDFLARE_ACCOUNT_ID.
export default defineConfig({
  worker: defineWorker({
    name: process.env.WORKER_NAME ?? "launch-spike-vinext",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-29",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      // Created on first deploy by `cf deploy --provision`.
      VINEXT_KV_CACHE: bindings.kv(),
      UPSTREAM_URL: bindings.text(process.env.UPSTREAM_URL ?? "https://httpbin.org/uuid"),
      // Values come from the shell at deploy time (scripts/deploy.mjs) and from
      // .env.local in local dev. They are never written to this file.
      REVALIDATE_SECRET: bindings.secret(),
      PREVIEW_SECRET: bindings.secret(),
    },
  }),
});
