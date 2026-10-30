import { spawnSync } from "node:child_process";
import path from "node:path";

// Helpers shared by the scripts. The Worker's name and settings live only in
// cloudflare.config.ts, so they are read from there and never repeated here.
import { loadAndParseConfig } from "@cloudflare/config";

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

// Evaluate cloudflare.config.ts the way the cf CLI does.
export const loadWorkerConfig = async (ctx) => {
  const { result } = await loadAndParseConfig(
    path.join(root, "cloudflare.config.ts"),
    ctx
  );

  if (!result.success) {
    console.error(result.error);
    process.exit(1);
  }

  return result.data;
};
