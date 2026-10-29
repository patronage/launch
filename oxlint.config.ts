import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

// Files the Payload CLI writes and rewrites.
const payloadGenerated = [
  "apps/payload/src/app/(payload)/**",
  "apps/payload/src/migrations/**",
  "apps/payload/src/payload-types.ts",
];

export default defineConfig({
  extends: [core, react, vitest, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "**/*.generated.ts",
    ...payloadGenerated,
  ],
});
