#!/usr/bin/env node
// Build and deploy the docs site with the cf CLI. No Wrangler, no wrangler.jsonc.
//
//   pnpm run deploy [--preview] [--dry-run]
//
// Production: `blume build`, then Build Output (scripts/build-output.mjs),
// then `cf deploy --prebuilt`, which creates the Worker on first run and
// updates it after that.
//
// --preview: the same build with CLOUDFLARE_PREVIEW_BUILD=true, then
// `cf previews deploy --prebuilt`, which names the Preview after the current
// Git branch. Workers Builds runs this for non-production branches.
//
// Auth comes from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (Workers
// Builds provides them) or a `cf auth login` session. The site has no secrets.
import { run } from "./worker-config.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") ? ["--dry-run"] : [];
const preview = args.has("--preview");

run("pnpm", ["run", "build"]);

run("node", ["scripts/build-output.mjs"], {
  CLOUDFLARE_PREVIEW_BUILD: preview ? "true" : "false",
});

if (preview) {
  run("pnpm", ["exec", "cf", "previews", "deploy", "--prebuilt", ...dryRun]);
} else {
  run("pnpm", ["exec", "cf", "deploy", "--prebuilt", ...dryRun]);
}
