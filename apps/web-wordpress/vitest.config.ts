import { defineConfig } from "vitest/config";

// Unit tests run without the vinext plugin from vite.config.ts.
export default defineConfig({
  resolve: {
    // tsconfig's "@/*" path, for route handlers' imports.
    alias: [{ find: /^@\//u, replacement: `${import.meta.dirname}/` }],
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
