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
    // vinext's handler wrapped with the request log (worker.ts).
    entrypoint: "./worker.ts",
    env: {
      ACCESS_PREVIEW_AUD: bindings.text(process.env.ACCESS_PREVIEW_AUD ?? ""),
      ACCESS_TEAM_DOMAIN: bindings.text(process.env.ACCESS_TEAM_DOMAIN ?? ""),
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
      WORDPRESS_ACCESS_CLIENT_ID: bindings.secret(),
      WORDPRESS_ACCESS_CLIENT_SECRET: bindings.secret(),
      WORDPRESS_ACCESS_PROOF_SECRET: bindings.secret(),
      WORDPRESS_PREVIEW_PASSWORD: bindings.secret(),
      WORDPRESS_PREVIEW_USER: bindings.secret(),
      WORDPRESS_URL: bindings.text(
        process.env.WORDPRESS_URL ?? "http://localhost:8080"
      ),
    },
    // WORKER_LOGPUSH=true sends this Worker's logs, evlog wide events
    // included, to the account's workers_trace_events Logpush job.
    logpush: process.env.WORKER_LOGPUSH === "true",
    name: process.env.WORKER_NAME ?? "launch-vinext-wordpress",
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
    // Production on workers.dev and Previews on <preview>-<worker>.<subdomain>.workers.dev.
    // The dashboard created this Worker with workers.dev off; a production deploy applies these.
    previewUrls: true,
    workersDev: true,
  }),
}));
