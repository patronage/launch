#!/usr/bin/env node
// pnpm run deploy [--preview] [--dry-run]. The steps are shared by every
// Worker; see packages/worker-scripts/src/deploy.ts.
import path from "node:path";

import { deploy } from "@launch/worker-scripts/deploy";
import { main } from "@launch/worker-scripts/script";

const root = path.resolve(import.meta.dirname, "..");

await main(root, (ctx) =>
  deploy(ctx, {
    // Payload hands the CMS to whoever creates the first user, so the deployed
    // Worker only allows that through Access (src/lib/first-user-guard.ts).
    beforeDeploy: ({ env, warn }, { preview }) => {
      // The demo's locales are for local trials: their schema has no
      // migrations a deployed database could be given (src/demo-locales.ts).
      if (env.PAYLOAD_DEMO_LOCALES) {
        throw new Error(
          "PAYLOAD_DEMO_LOCALES is set. It is for a local Payload only; unset it to deploy."
        );
      }

      if (!preview && !(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD)) {
        warn(
          "ACCESS_TEAM_DOMAIN and ACCESS_AUD are not set, so the deployed admin cannot create its first user. Protect /admin and /api with Access and deploy with both."
        );
      }
    },
    previews: true,
    secrets: true,
  })
);
