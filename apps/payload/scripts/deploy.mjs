#!/usr/bin/env node
// pnpm run deploy [--preview] [--dry-run]. The steps are shared by every
// Worker; see packages/worker-scripts/src/deploy.ts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deploy } from "@launch/worker-scripts/deploy";
import { main, run, ScriptError } from "@launch/worker-scripts/script";

const root = path.resolve(import.meta.dirname, "..");

/** The branch a Preview is for: Workers Builds names it, or the checkout's. */
const previewBranch = (ctx) => {
  if (ctx.env.WORKERS_CI_BRANCH) {
    return ctx.env.WORKERS_CI_BRANCH;
  }

  const result = ctx.spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    capture: true,
    cwd: ctx.root,
  });

  const branch = result.stdout?.trim();

  if (result.status !== 0 || !branch || branch === "HEAD") {
    throw new ScriptError(
      "Could not tell which branch this Preview is for. Check out a branch, or set WORKERS_CI_BRANCH."
    );
  }

  return branch;
};

/**
 * A Postgres Preview reads the preview database. Before the build, the
 * branch's database is made ready there (scripts/preview-schema.mjs): nothing
 * to do when the branch adds no migrations, or its own schema, migrated, when
 * it does. The Worker is then built with that schema (src/db.ts).
 */
const previewSchema = (ctx) => {
  if (!ctx.env.PREVIEW_DATABASE_URL) {
    throw new ScriptError(
      "A Postgres Preview needs PREVIEW_DATABASE_URL, a direct connection to the preview database, to prepare the branch's schema."
    );
  }

  const dir = mkdtempSync(path.join(tmpdir(), "payload-preview-"));
  const out = path.join(dir, "schema");

  try {
    run(ctx, "node", [
      "scripts/preview-schema.mjs",
      "prepare",
      "--branch",
      previewBranch(ctx),
      "--out",
      out,
    ]);

    return readFileSync(out, "utf-8").trim();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

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
    build: (step, { preview }) => {
      const schema =
        preview && step.env.PAYLOAD_DB === "postgres"
          ? previewSchema(step)
          : "";

      run(step, "pnpm", ["run", "build"], {
        CLOUDFLARE_PREVIEW_BUILD: preview ? "true" : "false",
        PAYLOAD_DB_SCHEMA: schema,
      });
    },
    previews: true,
    secrets: true,
  })
);
