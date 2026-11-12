#!/usr/bin/env node
// pnpm run builds:configure [--dry-run]. The steps and required ids are in
// packages/worker-scripts/src/workers-builds.ts.
import path from "node:path";

import { main } from "@launch/worker-scripts/script";
import { configureWorkersBuilds } from "@launch/worker-scripts/workers-builds";

const root = path.resolve(import.meta.dirname, "..");

await main(root, (ctx) =>
  configureWorkersBuilds(ctx, {
    // Read when the Worker is built.
    buildVariables: [
      "WORDPRESS_URL",
      "WORKER_DOMAIN",
      "WORKER_DOMAIN_PREVIEWS",
      "WORKER_NAME",
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_PREVIEW_AUD",
      "WORKER_LOGPUSH",
      "WORKER_TRACE_SAMPLING",
    ],
    previews: true,
  })
);
