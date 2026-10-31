#!/usr/bin/env node
// The first production deploy needs secrets; later Builds retain stored values.
import { spawnSync } from "node:child_process";

import { readWorkerConfig, root, run, secretNames } from "./worker-config.mjs";

// The gateway has no preview URLs: it serves only on its Access-protected
// custom domain (see cloudflare.config.ts).
const dryRun = process.argv.slice(2).includes("--dry-run");

run("pnpm", ["run", "build"]);

const deployArgs = [
  "exec",
  "cf",
  "deploy",
  "--prebuilt",
  ...(dryRun ? ["--dry-run"] : []),
];

// A dry run must never pass secret values to cf, because cf can include them
// in its diagnostic output.
if (dryRun) {
  run("pnpm", deployArgs);
  process.exit(0);
}

const names = secretNames(readWorkerConfig());
const present = names.filter((name) => process.env[name]);

if (present.length === 0) {
  run("pnpm", deployArgs);
  process.exit(0);
}

if (present.length !== names.length) {
  console.error(
    `Missing secret values: ${names.filter((name) => !process.env[name]).join(", ")}`
  );
  process.exit(1);
}

const result = spawnSync(
  "pnpm",
  [...deployArgs, "--secrets-file", "/dev/stdin"],
  {
    cwd: root,
    encoding: "utf-8",
    input: JSON.stringify(
      Object.fromEntries(names.map((name) => [name, process.env[name]]))
    ),
  }
);

// Suppress cf output when it receives values, including API error responses.
if (result.status !== 0) {
  console.error(`Deployment failed (exit ${result.status ?? "unknown"}).`);
  process.exit(result.status ?? 1);
}

console.log(`Deployed ${readWorkerConfig().name}; set ${names.join(", ")}.`);
