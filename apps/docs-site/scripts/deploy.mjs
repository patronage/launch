#!/usr/bin/env node
// Build and deploy the docs site with the cf CLI. No Wrangler, no wrangler.jsonc.
//
//   pnpm run deploy [--preview] [--dry-run]
//
// `blume build`, then Build Output (scripts/build-output.mjs), then the
// shared deploy steps in packages/worker-scripts/src/deploy.ts. Workers
// Builds runs --preview for non-production branches. The site has no secrets.
import { deploy } from "@launch/worker-scripts/deploy";
import { main, run } from "@launch/worker-scripts/script";

import { root } from "./worker-config.mjs";

await main(root, (ctx) =>
  deploy(ctx, {
    build: (_, { preview }) => {
      run(ctx, "pnpm", ["run", "build"]);
      run(ctx, "node", ["scripts/build-output.mjs"], {
        CLOUDFLARE_PREVIEW_BUILD: preview ? "true" : "false",
      });
    },
    previews: true,
    secrets: false,
  })
);
