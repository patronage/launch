import { bindings, defineConfig, defineWorker, triggers } from "cf/config";

// Optional custom domain for the site. Without one, the Worker is on
// workers.dev. Either way, an Access application must cover /_emdash/*.
const domain = process.env.WORKER_DOMAIN;

// Sender for EmDash's email (see astro.config.mjs). Without it, no email binding.
const emailFrom = process.env.EMAIL_FROM;

const env = {
  // The Access application's audience tag, for editor sign-in.
  ACCESS_AUD: bindings.text(process.env.ACCESS_AUD ?? ""),
  ASSETS: bindings.assets(),
  // Content, users and settings. Created on first deploy.
  DB: bindings.d1(),
  // Signs and checks EmDash's preview links.
  EMDASH_PREVIEW_SECRET: bindings.secret(),
  // Cloudflare Images, for EmDash's image transforms.
  IMAGES: bindings.images(),
  // Uploaded media. Created on first deploy.
  MEDIA: bindings.r2(),
  // Astro sessions. Created on first deploy.
  SESSION: bindings.kv(),
};

// Cloudflare Email Sending, limited to the one sender address.
const email = emailFrom
  ? bindings.sendEmail({ allowedSenderAddresses: [emailFrom] })
  : null;

// The cf CLI's typed Worker config, in place of wrangler.jsonc (ADR 0003).
// @astrojs/cloudflare 15 reads it for `astro dev` and `astro build`, and
// `cf deploy --prebuilt` uploads the Build Output that `astro build` writes to
// .cloudflare/output/v1. The account comes from CLOUDFLARE_ACCOUNT_ID.
export default defineConfig({
  worker: defineWorker({
    compatibilityDate: "2026-10-29",
    compatibilityFlags: ["nodejs_compat"],
    domains: domain
      ? [{ hostname: domain, previews: false, production: true }]
      : [],
    entrypoint: "./src/worker.ts",
    env: email ? { ...env, EMAIL: email } : env,
    name: process.env.WORKER_NAME ?? "launch-emdash",
    observability: {
      enabled: true,
      issues: { enabled: true },
      logs: { enabled: true, headSamplingRate: 1 },
      // Query strings can carry preview tokens; keep them out of logs and traces.
      redactQueryString: true,
    },
    previewUrls: false,
    // EmDash publishes scheduled entries from the Worker's scheduled handler.
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
    workersDev: !domain,
  }),
});
