#!/usr/bin/env node
// Set this Worker's runtime secrets from the environment, without deploying.
//
//   REVALIDATE_SECRET=... PREVIEW_SECRET=... pnpm run secrets [--dry-run]
//
// Secret names come from bindings.secret() in cloudflare.config.ts. Secrets
// that are not in the environment are left unchanged on the Worker.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readWorkerConfig, run, secretNames } from "./worker-config.mjs";

const dryRun = process.argv.includes("--dry-run");

run("pnpm", ["exec", "vite", "build"]);

const workerConfig = readWorkerConfig();

const secrets = Object.fromEntries(
  secretNames(workerConfig)
    .filter((name) => process.env[name])
    .map((name) => [name, { text: process.env[name], type: "secret_text" }])
);

if (Object.keys(secrets).length === 0) {
  console.error("No secret values found in the environment.");
  process.exit(1);
}

if (dryRun) {
  // cf's own --dry-run prints the request body, values included, so stop here.
  console.log(`Would set: ${Object.keys(secrets).join(", ")}`);
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "cf-secrets-"));
const secretsFile = path.join(dir, "secrets.json");

writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });

try {
  run("pnpm", [
    "exec",
    "cf",
    "workers",
    "secrets",
    "bulk",
    "--worker",
    workerConfig.name,
    "--secrets",
    `@${secretsFile}`,
  ]);
} finally {
  rmSync(dir, { force: true, recursive: true });
}
