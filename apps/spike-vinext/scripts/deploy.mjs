#!/usr/bin/env node
// Build and deploy this Worker with the cf CLI. No Wrangler, no wrangler.jsonc.
//
//   pnpm run deploy [--preview] [--dry-run]
//
// Production: `vite build`, then `cf deploy --prebuilt`, which creates the
// Worker on first run, updates it after that, and provisions binding resources
// (the KV namespace) that do not exist yet.
//
// --preview: a Preview build (CLOUDFLARE_PREVIEW_BUILD=true), then
// `cf previews deploy --prebuilt`, which names the Preview after the current
// Git branch. Workers Builds runs this for non-production branches.
//
// Auth comes from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (Workers
// Builds provides them) or a `cf auth login` session. If every secret declared
// in cloudflare.config.ts has a value in the environment, production deploys
// upload them with the version; if none do, the Worker keeps the secrets it
// already has (set them with `pnpm run secrets`).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readWorkerConfig, run, secretNames } from "./worker-config.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const preview = args.has("--preview");

run("pnpm", ["exec", "vite", "build"], {
  CLOUDFLARE_PREVIEW_BUILD: preview ? "true" : "false",
});

if (preview) {
  run("pnpm", [
    "exec",
    "cf",
    "previews",
    "deploy",
    "--prebuilt",
    ...(dryRun ? ["--dry-run"] : []),
  ]);
  process.exit(0);
}

const names = secretNames(readWorkerConfig());
const present = names.filter((name) => process.env[name]);

if (present.length > 0 && present.length < names.length) {
  const missing = names.filter((name) => !process.env[name]);

  console.error(`Missing secret values: ${missing.join(", ")}`);
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "cf-secrets-"));

try {
  const deployArgs = ["exec", "cf", "deploy", "--prebuilt"];

  if (present.length > 0) {
    const secretsFile = path.join(dir, "secrets.json");

    writeFileSync(
      secretsFile,
      JSON.stringify(
        Object.fromEntries(names.map((name) => [name, process.env[name]]))
      ),
      { mode: 0o600 }
    );
    deployArgs.push("--secrets-file", secretsFile);
  }

  if (dryRun) {
    deployArgs.push("--dry-run");
  }

  run("pnpm", deployArgs);
} finally {
  rmSync(dir, { force: true, recursive: true });
}
