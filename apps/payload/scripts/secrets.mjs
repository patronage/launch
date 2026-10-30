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

if (process.argv.includes("--preview-base")) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (!(account && token)) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
    process.exit(1);
  }

  // Same merge-patch endpoint used by Cloudflare's Preview base secret CLI.
  // Omitted bindings are preserved; the response is never logged.
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/workers/${encodeURIComponent(worker.name)}`,
      {
        body: JSON.stringify({ previews_base_config: { env: secrets } }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/merge-patch+json",
        },
        method: "PATCH",
      }
    );

    const body = await response.json();

    if (!response.ok || body.success !== true) {
      console.error(
        `Preview base secret upload failed (HTTP ${response.status}).`
      );
      process.exit(1);
    }
  } catch {
    console.error("Preview base secret upload failed.");
    process.exit(1);
  }

  console.log(`Set in Previews Base: ${names.join(", ")}`);
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
