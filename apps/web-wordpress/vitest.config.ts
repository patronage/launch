import { defineConfig } from "vitest/config";

// Unit tests run without the vinext plugin from vite.config.ts.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
  },
});
