// Runs this checkout's Postgres migrations into a branch preview's schema:
// `pnpm payload run scripts/preview-migrate.ts`, started by
// scripts/preview-schema.mjs with PAYLOAD_DB_SCHEMA set and search_path in
// POSTGRES_URL. PREVIEW_MIGRATE_ONLY (a JSON list of names) limits the run to
// those migrations, to bring a new schema to the shared copy's level first.
// PREVIEW_MIGRATIONS_EXTRA adds one migration file, for the e2e test.
import path from "node:path";

import config from "@payload-config";
import { getPayload } from "payload";

import { migrations } from "../src/migrations/postgres";

const schema = process.env.PAYLOAD_DB_SCHEMA;

if (!(schema && process.env.POSTGRES_URL?.includes("search_path"))) {
  throw new Error(
    "preview-migrate runs only for a preview schema, with search_path in POSTGRES_URL."
  );
}

const only = process.env.PREVIEW_MIGRATE_ONLY
  ? new Set<string>(JSON.parse(process.env.PREVIEW_MIGRATE_ONLY))
  : undefined;

const extraFile = process.env.PREVIEW_MIGRATIONS_EXTRA;

const all = extraFile
  ? [
      ...migrations,
      {
        ...(await import(path.resolve(extraFile))),
        name: path.basename(extraFile, ".ts"),
      },
    ]
  : migrations;

const payload = await getPayload({ config });

try {
  await payload.db.migrate({
    migrations: only
      ? all.filter((migration) => only.has(migration.name))
      : all,
  });
} finally {
  await payload.destroy();
}
