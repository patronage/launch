import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// Files the Payload CLI writes and rewrites.
const payloadGenerated = [
  "apps/payload/src/app/(payload)/**",
  "apps/payload/src/migrations/**",
  "apps/payload/src/payload-types.ts",
];

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/*.generated.ts",
    ...payloadGenerated,
    // Written by `pnpm --filter @launch/adapter-wordpress codegen`.
    "packages/adapter-wordpress/src/gql/**",
  ],
});
