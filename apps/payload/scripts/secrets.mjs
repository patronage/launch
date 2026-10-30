#!/usr/bin/env node
// Send secrets through stdin: no values in files, command arguments or logs.
import { spawnSync } from "node:child_process";

import { readWorkerConfig, root, run, secretNames } from "./worker-config.mjs";

run("pnpm", ["run", "build"]);

const worker = readWorkerConfig();

const secrets = Object.fromEntries(
  secretNames(worker)
    .filter((name) => process.env[name])
    .map((name) => [name, { text: process.env[name], type: "secret_text" }])
);

const names = Object.keys(secrets);

if (names.length === 0) {
  console.error("No secret values found in the environment.");
  process.exit(1);
}

if (process.argv.includes("--dry-run")) {
  console.log(`Would set: ${names.join(", ")}`);
  process.exit(0);
}

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "cf",
    "workers",
    "secrets",
    "bulk",
    "--worker",
    worker.name,
    "--secrets",
    "@/dev/stdin",
  ],
  { cwd: root, encoding: "utf-8", input: JSON.stringify(secrets) }
);

// The API response may contain submitted values; report only names and status.
if (result.status !== 0) {
  console.error(`Secret upload failed (exit ${result.status ?? "unknown"}).`);
  process.exit(result.status ?? 1);
}

console.log(`Set: ${names.join(", ")}`);
