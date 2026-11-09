#!/usr/bin/env node
// pnpm run builds:configure [--dry-run]. The steps and required ids are in
// packages/worker-scripts/src/workers-builds.ts.
//
// Previews are off unless WORKER_PREVIEWS=true. A Payload Preview never binds
// production content (cloudflare.config.ts), so branch builds need their own
// D1 database and media bucket, and Preview base secrets set first with
// `pnpm run secrets --preview-base`.
import path from "node:path";

import { main } from "@launch/worker-scripts/script";
import { configureWorkersBuilds } from "@launch/worker-scripts/workers-builds";

const root = path.resolve(import.meta.dirname, "..");

await main(root, (ctx) =>
  configureWorkersBuilds(ctx, {
    // Database selection, the custom domain and the Access settings are read
    // at build time.
    buildVariables: [
      "PAYLOAD_DB",
      "HYPERDRIVE_ID",
      "WORKER_DOMAIN",
      "WORKER_LOGPUSH",
      "WORKER_TRACE_SAMPLING",
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_AUD",
      "ACCESS_GATEWAY_AUD",
    ],
    previewVariables: [
      "PAYLOAD_PREVIEW_D1_ID",
      "PAYLOAD_PREVIEW_D1_NAME",
      "PAYLOAD_PREVIEW_R2_BUCKET",
    ],
    previews: ctx.env.WORKER_PREVIEWS === "true",
    previewsNeedBaseSecrets: true,
  })
);
