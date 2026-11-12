import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests for the app's own modules. They run in node without the vinext
// and Cloudflare plugins from vite.config.ts, so a tested module must not
// import `cloudflare:workers` or the Payload config.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
