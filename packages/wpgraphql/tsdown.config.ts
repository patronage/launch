import { defineConfig } from "tsdown";

// The npm build: ES modules and type declarations in dist/. In the workspace
// the package exports its TypeScript source; publishConfig swaps in dist/.
// The Access and logging packages stay dependencies, not bundled copies.
export default defineConfig({
  deps: { neverBundle: [/^@patronage\//u, /^node:/u] },
  dts: true,
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
});
