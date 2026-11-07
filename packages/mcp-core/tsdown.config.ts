import { defineConfig } from "tsdown";

// The npm build: ES modules and type declarations in dist/. In the workspace
// the package exports its TypeScript source; publishConfig swaps in dist/.
export default defineConfig({
  deps: { neverBundle: ["cloudflare:workers"] },
  dts: true,
  entry: ["src/index.ts", "src/runtime.ts"],
  format: "esm",
  platform: "neutral",
});
