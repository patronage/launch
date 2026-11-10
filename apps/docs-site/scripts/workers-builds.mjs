#!/usr/bin/env node
// pnpm run builds:configure [--dry-run]. The steps and required ids are in
// packages/worker-scripts/src/workers-builds.ts.
import { main } from "@launch/worker-scripts/script";
import { configureWorkersBuilds } from "@launch/worker-scripts/workers-builds";

import { loadWorkerConfig, root } from "./worker-config.mjs";

await main(root, (ctx) =>
  configureWorkersBuilds(ctx, {
    // Read when the site is built.
    buildVariables: ["WORKER_NAME", "WORKER_DOMAIN", "WORKER_DOMAIN_PREVIEWS"],
    // The research notes in docs/ publish on this site.
    extraWatchPaths: ["docs/*"],
    previews: true,
    // Blume has no Vite build, so read cloudflare.config.ts directly.
    resolveWorker: async () => {
      const { worker } = await loadWorkerConfig({
        isPreview: false,
        mode: "production",
      });

      return { name: worker.name, secretNames: [] };
    },
  })
);
