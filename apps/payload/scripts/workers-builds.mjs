#!/usr/bin/env node
// pnpm run builds:configure [--dry-run]. The steps and required ids are in
// packages/worker-scripts/src/workers-builds.ts.
//
// Previews are off unless WORKER_PREVIEWS=true. A Payload Preview never binds
// production content (cloudflare.config.ts), so branch builds need their own
// database (a D1, or on Postgres the preview database's Hyperdrive config) and
// media bucket, and Preview base secrets set first with
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
    // A Postgres Preview also needs PREVIEW_DATABASE_URL at build time, to
    // prepare its schema. It is a secret, so it is set on the trigger by hand
    // (README, "Branch previews on Postgres"), never passed through here.
    previewVariables:
      ctx.env.PAYLOAD_DB === "postgres"
        ? ["PAYLOAD_PREVIEW_HYPERDRIVE_ID", "PAYLOAD_PREVIEW_R2_BUCKET"]
        : [
            "PAYLOAD_PREVIEW_D1_ID",
            "PAYLOAD_PREVIEW_D1_NAME",
            "PAYLOAD_PREVIEW_R2_BUCKET",
          ],
    previews: ctx.env.WORKER_PREVIEWS === "true",
    previewsNeedBaseSecrets: true,
  })
);
