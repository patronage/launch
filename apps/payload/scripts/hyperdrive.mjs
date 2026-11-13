#!/usr/bin/env node
// pnpm run hyperdrive:configure [--branch <name>] [--dry-run]
//
// Creates the Hyperdrive configuration the Worker uses with PAYLOAD_DB=postgres,
// or finds it if it exists, and prints its id for HYPERDRIVE_ID. It uses
// Hyperdrive's managed PlanetScale integration, so no database password is
// handled here: Cloudflare and PlanetScale arrange the credentials. The
// PlanetScale organization, database and default branch are the ones
// `pnpm db:pull` reads, from db-pull.env.
//
// The configuration is named after the database, with the branch appended for
// any branch but the default (launch-payload, launch-payload-staging). Query
// caching is turned off: the admin reads what it has just written, and a
// cached read would show the old version.
//
// Run with the cf CLI signed in to the Cloudflare account. --dry-run prints
// the commands and runs only the read.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { main, run, runJson, ScriptError } from "@launch/worker-scripts/script";
import { z } from "zod";

const root = path.resolve(import.meta.dirname, "..");

/** PSCALE_ORG, PSCALE_DATABASE and PSCALE_BRANCH from db-pull.env. */
export const planetScaleSettings = (text) => {
  const settings = {};

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?<key>PSCALE_[A-Z]+)=(?<value>.*)$/u);

    if (match) {
      settings[match.groups.key] = match.groups.value;
    }
  }

  const { PSCALE_BRANCH, PSCALE_DATABASE, PSCALE_ORG } = settings;

  if (!(PSCALE_ORG && PSCALE_DATABASE && PSCALE_BRANCH)) {
    throw new ScriptError(
      "db-pull.env needs PSCALE_ORG, PSCALE_DATABASE and PSCALE_BRANCH."
    );
  }

  return {
    branch: PSCALE_BRANCH,
    database: PSCALE_DATABASE,
    organization: PSCALE_ORG,
  };
};

/** The configuration's name: the database, plus any non-default branch. */
export const configName = (database, branch, defaultBranch) =>
  branch === defaultBranch ? database : `${database}-${branch}`;

const configsSchema = z.array(
  z.object({ id: z.string(), name: z.string() }).loose()
);

const createdSchema = z.object({ id: z.string() }).loose();

export const configureHyperdrive = (ctx) => {
  const { values } = parseArgs({
    args: [...ctx.argv],
    options: {
      branch: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });

  const settings = planetScaleSettings(
    readFileSync(path.join(ctx.root, "db-pull.env"), "utf-8")
  );

  const branch = values.branch ?? settings.branch;

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(branch)) {
    throw new ScriptError(`"${branch}" is not a PlanetScale branch name.`);
  }

  const name = configName(settings.database, branch, settings.branch);
  const dryRun = values["dry-run"] === true;

  const existing = runJson(
    ctx,
    "Listing Hyperdrive configurations",
    "pnpm",
    ["exec", "cf", "hyperdrive", "list", "--per-page", "100"],
    configsSchema
  ).find((config) => config.name === name);

  const create = [
    "exec",
    "cf",
    "hyperdrive",
    "create",
    "--name",
    name,
    "--integration-provider",
    "planetscale",
    "--integration-scheme",
    "postgres",
    "--integration-organization-name",
    settings.organization,
    "--integration-database-name",
    settings.database,
    "--integration-database-branch-name",
    branch,
  ];

  let id = existing?.id;

  if (id) {
    ctx.log(`Hyperdrive configuration ${name} exists: ${id}`);
  } else if (dryRun) {
    ctx.log(`Would run: pnpm ${create.join(" ")}`);
  } else {
    ({ id } = runJson(
      ctx,
      "Creating the Hyperdrive configuration",
      "pnpm",
      create,
      createdSchema
    ));
    ctx.log(`Created Hyperdrive configuration ${name}: ${id}`);
  }

  const noCache = [
    "exec",
    "cf",
    "hyperdrive",
    "update",
    id ?? "<id>",
    "--caching-disabled",
  ];

  if (dryRun) {
    ctx.log(`Would run: pnpm ${noCache.join(" ")}`);
    ctx.log("Dry run: nothing was created or changed.");

    return;
  }

  run(ctx, "pnpm", noCache);
  ctx.log(
    `Query caching is off. Build the Worker with PAYLOAD_DB=postgres and HYPERDRIVE_ID=${id} (pnpm run builds:configure sets them on the Workers Builds trigger).`
  );
};

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  await main(root, configureHyperdrive);
}
