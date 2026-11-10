import path from "node:path";

// Helpers shared by the scripts. The Worker's name and settings live only in
// cloudflare.config.ts, so they are read from there and never repeated here.
import { loadAndParseConfig } from "@cloudflare/config";

export const root = path.resolve(import.meta.dirname, "..");

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
