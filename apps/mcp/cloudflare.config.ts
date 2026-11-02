import { bindings, defineConfig, defineWorker, exports } from "cf/config";

const name = process.env.WORKER_NAME ?? "launch-mcp";

// The MCP endpoint's hostname. The Access application must cover `/mcp*`,
// because the browser approval page lives under `/mcp/approvals/`.
const domain = process.env.WORKER_DOMAIN;

// The Payload Worker to reach over a Service binding, when this site has one.
const payloadWorker = process.env.PAYLOAD_WORKER;

// Or Payload's public origin, reached through its Access application with a
// service token. One of the two turns the `payload` connector on.
const payloadUrl = process.env.PAYLOAD_API_URL ?? "";
const payloadOn = Boolean(payloadWorker || payloadUrl);

// The cf CLI's typed Worker config, in place of wrangler.jsonc (ADR 0003).
// The account comes from CLOUDFLARE_ACCOUNT_ID.
export default defineConfig({
  worker: defineWorker({
    compatibilityDate: "2026-10-29",
    compatibilityFlags: ["nodejs_compat"],
    domains: domain
      ? [{ hostname: domain, previews: false, production: true }]
      : [],
    entrypoint: "./src/worker.ts",
    env: {
      // Access application in front of this Worker.
      ACCESS_AUD: bindings.text(process.env.ACCESS_AUD ?? ""),
      ACCESS_TEAM_DOMAIN: bindings.text(process.env.ACCESS_TEAM_DOMAIN ?? ""),
      // Off everywhere: on, it offers the approval card and its token to
      // clients that never advertised MCP Apps support (see README).
      APPROVAL_CARD_FOR_UNKNOWN_CLIENTS: bindings.text("false"),
      // Signs the approval tokens; every approval fails closed without it.
      APPROVAL_CSRF_SECRET: bindings.secret(),
      DEPLOYMENT_ENVIRONMENT: bindings.text(
        process.env.DEPLOYMENT_ENVIRONMENT ?? "development"
      ),
      // Runs the model's code in a Dynamic Worker (paid plan, open beta).
      LOADER: bindings.workerLoader(),
      MCP_ALLOWED_HOSTNAMES: bindings.text(domain ?? ""),
      // Payload, when this site has it: a Service binding to its Worker, or
      // its URL reached through Access with a service token.
      PAYLOAD:
        Boolean(payloadWorker) &&
        bindings.worker({ worker: payloadWorker ?? "" }),
      // Only needed when Payload is reached by URL through Access.
      PAYLOAD_ACCESS_CLIENT_ID: Boolean(payloadUrl) && bindings.secret(),
      PAYLOAD_ACCESS_CLIENT_SECRET: Boolean(payloadUrl) && bindings.secret(),
      // The secret Payload checks before it trusts a forwarded Access JWT
      // (ACCESS_GATEWAY_PROOF_SECRET on the Payload Worker).
      PAYLOAD_ACCESS_PROOF_SECRET: payloadOn && bindings.secret(),
      // Payload's admin origin, for the approval page's "open in admin" link.
      PAYLOAD_ADMIN_URL: bindings.text(process.env.PAYLOAD_ADMIN_URL ?? ""),
      PAYLOAD_API_URL: bindings.text(payloadUrl),
      // The Access service token that gets requests through the Access
      // application in front of WordPress, and the gateway proof secret that
      // WordPress's patronage-access mu-plugin checks.
      WORDPRESS_ACCESS_CLIENT_ID: bindings.secret(),
      WORDPRESS_ACCESS_CLIENT_SECRET: bindings.secret(),
      WORDPRESS_ACCESS_PROOF_SECRET: bindings.secret(),
      // The WordPress origin, without /wp-json. HTTPS outside localhost.
      WORDPRESS_API_URL: bindings.text(
        process.env.WORDPRESS_API_URL ?? "http://localhost:8080"
      ),
      WORDPRESS_RUNTIME: bindings.durableObject({
        exportName: "WordPressRuntime",
        worker: name,
      }),
    },
    exports: {
      WordPressRuntime: exports.durableObject({ storage: "sqlite" }),
    },
    // WORKER_LOGPUSH=true sends this Worker's logs, its evlog wide events
    // included, to the account's workers_trace_events Logpush job.
    logpush: process.env.WORKER_LOGPUSH === "true",
    name,
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
    // Serve only on the Access-protected custom domain.
    previewUrls: false,
    workersDev: false,
  }),
});
