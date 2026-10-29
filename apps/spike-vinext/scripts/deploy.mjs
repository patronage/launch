#!/usr/bin/env node
// Build and deploy this Worker with the cf CLI. No Wrangler, no wrangler.jsonc.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   REVALIDATE_SECRET=... PREVIEW_SECRET=... pnpm run deploy [--dry-run] [--skip-build]
//
// Worker settings and bindings live in cloudflare.config.ts. `cf deploy`
// creates the Worker on first run, updates it after that, and provisions any
// binding resources (the KV namespace) that do not exist yet. Secret values are
// read from the environment and uploaded with the version, so they never touch
// the repo.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const root = new URL("..", import.meta.url).pathname;

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID.");
  process.exit(1);
}
if (!dryRun && !process.env.CLOUDFLARE_API_TOKEN) {
  console.warn("CLOUDFLARE_API_TOKEN is not set; falling back to a `cf auth login` session.");
}

if (!args.has("--skip-build")) run("pnpm", ["exec", "vite", "build"]);

// The build writes the resolved Worker config, including which bindings are secrets.
const workerConfig = JSON.parse(
  readFileSync(join(root, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8"),
);
const secretNames = Object.entries(workerConfig.env ?? {})
  .filter(([, binding]) => binding.type === "secret")
  .map(([name]) => name);
const missing = secretNames.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing secret values in the environment: ${missing.join(", ")}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "cf-secrets-"));
const secretsFile = join(dir, "secrets.json");
writeFileSync(
  secretsFile,
  JSON.stringify(Object.fromEntries(secretNames.map((name) => [name, process.env[name]]))),
  { mode: 0o600 },
);
try {
  const deployArgs = ["exec", "cf", "deploy", "--prebuilt", "--secrets-file", secretsFile];
  if (dryRun) deployArgs.push("--dry-run");
  run("pnpm", deployArgs);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
