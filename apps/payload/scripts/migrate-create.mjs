#!/usr/bin/env node
// pnpm migrate:create <name> [payload migrate:create flags]
//
// Writes a migration for each database the app supports, from one config
// change: `pnpm payload migrate:create` once for D1 and once with
// PAYLOAD_DB=postgres. Then deletes the `"public".` that Payload writes before
// enum and foreign-key names in the new Postgres migration, so it follows
// search_path and a branch preview can run it into its own schema (ADR 0021).
// scripts/preview-schema.test.mjs fails if a migration still has the prefix.
//
// The Postgres step reads POSTGRES_URL like the rest of the CLI: run
// `pnpm db` first for the local Postgres.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.join(import.meta.dirname, "..");
const POSTGRES_DIR = path.join(APP_DIR, "src", "migrations", "postgres");
const PREFIX = '"public".';

/** `"public"."name"` becomes `"name"`; nothing else changes. */
export const stripPublic = (text) => text.replaceAll(PREFIX, "");

const migrationFiles = () =>
  new Set(
    readdirSync(POSTGRES_DIR).filter(
      (file) => file.endsWith(".ts") && file !== "index.ts"
    )
  );

const payload = (args, env) => {
  const result = spawnSync("pnpm", ["payload", "migrate:create", ...args], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.stderr.write(
      `migrate:create failed for ${env.PAYLOAD_DB ?? "d1"} (exit ${result.status}).\n`
    );
    process.exit(result.status ?? 1);
  }
};

const main = () => {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith("-")) {
    process.stderr.write("Usage: pnpm migrate:create <name> [flags]\n");
    process.exit(1);
  }

  payload(args, { PAYLOAD_DB: "d1" });

  const before = migrationFiles();
  payload(args, { PAYLOAD_DB: "postgres" });

  for (const file of migrationFiles()) {
    if (before.has(file)) {
      continue;
    }

    const full = path.join(POSTGRES_DIR, file);
    const text = readFileSync(full, "utf-8");
    const stripped = stripPublic(text);

    if (stripped !== text) {
      writeFileSync(full, stripped);
      console.log(`Removed "public". from src/migrations/postgres/${file}.`);
    }
  }
};

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  main();
}
