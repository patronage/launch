import { bindings, defineConfig, defineWorker } from "cf/config";

// PAYLOAD_DB=postgres swaps D1 for Postgres through Hyperdrive (see src/db.ts).
const usePostgres = process.env.PAYLOAD_DB === "postgres";

export default defineConfig({
  worker: defineWorker({
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    compatibilityDate: "2026-10-29",
    compatibilityFlags: ["nodejs_compat"],
    domains: process.env.WORKER_DOMAIN
      ? [
          {
            hostname: process.env.WORKER_DOMAIN,
            previews: false,
            production: true,
          },
        ]
      : [],
    entrypoint: "vinext/server/fetch-handler",
    env: {
      // Access application for /admin and /api; empty turns the Access sign-in off.
      ACCESS_AUD: bindings.text(process.env.ACCESS_AUD ?? ""),
      ACCESS_TEAM_DOMAIN: bindings.text(process.env.ACCESS_TEAM_DOMAIN ?? ""),
      ASSETS: bindings.assets(),
      D1:
        !usePostgres &&
        bindings.d1({
          id: "8503df2d-e2f5-45ec-8bf3-8fec186b2a95",
          name: "launch-payload",
        }),
      HYPERDRIVE:
        usePostgres &&
        bindings.hyperdrive({
          dev: { connectionString: process.env.POSTGRES_URL },
          id: process.env.HYPERDRIVE_ID ?? "local",
        }),
      // Resizes media for the front end (app/(frontend)/media).
      IMAGES: bindings.images(),
      PAYLOAD_SECRET: bindings.secret(),
      R2: bindings.r2({ name: "launch-payload-media" }),
    },
    name: "launch-payload",
    previewUrls: false,
    workersDev: true,
  }),
});
