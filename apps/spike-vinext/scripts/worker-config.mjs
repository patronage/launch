// Helpers shared by the deploy scripts. They read the Worker config that
// `vite build` resolves from cloudflare.config.ts, so names and bindings are
// never repeated here.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

export const run = (cmd, cmdArgs, env = {}) => {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

export const readWorkerConfig = () =>
  JSON.parse(
    readFileSync(
      path.join(
        root,
        ".cloudflare/output/v0/workers/default/worker.config.json"
      ),
      "utf-8"
    )
  );

export const secretNames = (workerConfig) =>
  Object.entries(workerConfig.env ?? {})
    .filter(([, binding]) => binding.type === "secret")
    .map(([name]) => name);
