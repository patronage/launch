import { defineConfig } from "deepsec/config";

import { launchMatchers } from "./matchers.mjs";

export default defineConfig({
  ai: { mode: "local", provider: "local" },
  dataDir: "/scanner/data",
  defaultAgent: "codex",
  defaultModel: "gpt-6-astra",
  defaultThinkingLevel: "xhigh",
  plugins: [launchMatchers],
  projects: [
    {
      id: "launch",
      // Intentionally unusable against the live checkout. Mounted by security:scan.
      root: "/repo",
    },
  ],
});
