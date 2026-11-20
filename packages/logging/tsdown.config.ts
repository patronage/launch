import { defineConfig } from "tsdown";

// The npm build: ES modules and type declarations in dist/. In the workspace
// the package exports its TypeScript source; publishConfig swaps in dist/.
// node:async_hooks needs the nodejs_compat flag on Workers.
export default defineConfig({
  deps: { neverBundle: [/^node:/u] },
  dts: true,
  entry: ["src/worker.ts", "src/cloudflare.ts", "src/probe.ts"],
  format: "esm",
  platform: "neutral",
});
