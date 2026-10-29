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
    entrypoint: "vinext/server/fetch-handler",
    env: {
      ASSETS: bindings.assets(),
      D1: !usePostgres && bindings.d1({ name: "launch-payload" }),
      HYPERDRIVE:
        usePostgres &&
        bindings.hyperdrive({
          dev: { connectionString: process.env.POSTGRES_URL },
          id: process.env.HYPERDRIVE_ID ?? "local",
        }),
      PAYLOAD_SECRET: bindings.secret(),
      R2: bindings.r2({ name: "launch-payload-media" }),
    },
    name: "launch-payload",
  }),
});
