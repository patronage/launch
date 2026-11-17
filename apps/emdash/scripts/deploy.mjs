#!/usr/bin/env node
// pnpm run deploy [--dry-run]. The steps are shared by every Worker; see
// packages/worker-scripts/src/deploy.ts. There are no preview deploys: the D1
// database and R2 bucket are shared, so a preview would edit production.
import path from "node:path";

import { deploy } from "@launch/worker-scripts/deploy";
import { main, ScriptError } from "@launch/worker-scripts/script";

const root = path.resolve(import.meta.dirname, "..");

await main(root, (ctx) => {
  // Without these, the admin would fall back to EmDash's own passkey sign-in,
  // open to the internet. Every CMS sits behind Access (ADR 0011).
  const missing = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"].filter(
    (name) => !ctx.env[name]
  );

  if (missing.length > 0 && !ctx.argv.includes("--dry-run")) {
    throw new ScriptError(
      `Set ${missing.join(" and ")}: the admin must sign in through Cloudflare Access.`
    );
  }

  return deploy(ctx, { previews: false, secrets: true });
});
