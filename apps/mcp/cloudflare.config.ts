import { bindings, defineConfig, defineWorker, exports } from "cf/config";

const name = process.env.WORKER_NAME ?? "launch-mcp";

// The MCP endpoint's hostname. The Access application must cover `/mcp*`,
// because the browser approval page lives under `/mcp/approvals/`.
const domain = process.env.WORKER_DOMAIN;

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
    name,
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1 },
    },
    // Serve only on the Access-protected custom domain.
    previewUrls: false,
    workersDev: false,
  }),
});
