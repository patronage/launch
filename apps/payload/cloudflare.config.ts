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
    // vinext's handler wrapped with the request log (worker.ts).
    entrypoint: "./worker.ts",
    env: {
      // Access application for /admin and /api; empty turns the Access sign-in off.
      ACCESS_AUD: bindings.text(process.env.ACCESS_AUD ?? ""),
      // The MCP gateway's Access application, whose editors' JWTs the gateway
      // forwards, and the proof secret it signs them with. Both or neither.
      ACCESS_GATEWAY_AUD: bindings.text(process.env.ACCESS_GATEWAY_AUD ?? ""),
      ACCESS_GATEWAY_PROOF_SECRET:
        Boolean(process.env.ACCESS_GATEWAY_AUD) && bindings.secret(),
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
    // WORKER_LOGPUSH=true sends this Worker's logs, evlog wide events
    // included, to the account's workers_trace_events Logpush job.
    logpush: process.env.WORKER_LOGPUSH === "true",
    name: "launch-payload",
    // Workers Logs: seven days of this Worker's console output, evlog wide
    // events included, searchable in the dashboard.
    observability: {
      enabled: true,
      // Group exceptions and 5xx responses into Issues in the dashboard.
      issues: { enabled: true },
      logs: { enabled: true, headSamplingRate: 1 },
      // Query strings can carry preview tokens; keep them out of logs and traces.
      redactQueryString: true,
      // Automatic tracing: a span for each subrequest and binding call, kept
      // seven days. WORKER_TRACE_SAMPLING (0 to 1) lowers it for busy sites.
      traces: {
        enabled: true,
        headSamplingRate: Number(process.env.WORKER_TRACE_SAMPLING || 1),
      },
    },
    previewUrls: false,
    workersDev: true,
  }),
});
