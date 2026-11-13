import { timedD1 } from "@patronage/logging";
import { env } from "cloudflare:workers";
import type { Config } from "payload";

import { DEMO_LOCALES_DIR, hasDemoLocales } from "./demo-locales";
import { migrations as d1Migrations } from "./migrations/d1";

// PAYLOAD_DB picks the database when the Worker is built (Vite replaces it with
// a constant, so the other adapter is left out of the bundle) and when the
// Payload CLI runs. D1 is the default; `postgres` connects through Hyperdrive.
//
// Schema push needs drizzle-kit, which cannot load inside workerd, so every
// environment uses migrations: `pnpm payload migrate` locally, and
// `prodMigrations` when the deployed Worker first boots.
// cloudflare.config.ts declares D1 or HYPERDRIVE depending on PAYLOAD_DB.
const binding = <T>(value: T | undefined, name: string): T => {
  if (!value) {
    throw new Error(`The ${name} binding is missing. Check PAYLOAD_DB.`);
  }

  return value;
};

export const database = async (): Promise<Config["db"]> => {
  if (process.env.PAYLOAD_DB === "postgres") {
    if (hasDemoLocales) {
      throw new Error(
        "PAYLOAD_DEMO_LOCALES works with the local D1 only. Unset PAYLOAD_DB."
      );
    }

    const schemaName = process.env.PAYLOAD_DB_SCHEMA || undefined;

    // A branch preview with its own migrations reads its own schema
    // (scripts/preview-schema.mjs). The pattern matches SCHEMA_PATTERN there.
    if (schemaName && !/^preview_[0-9a-f]{12}$/u.test(schemaName)) {
      throw new Error(
        `PAYLOAD_DB_SCHEMA must look like preview_<12 hex digits>, not "${schemaName}".`
      );
    }

    const { postgresAdapter } = await import("@payloadcms/db-postgres");
    const { migrations } = await import("./migrations/postgres");
    const { requestScopedPg } = await import("./request-scoped-pg");

    const adapterArgs: Parameters<typeof postgresAdapter>[0] = {
      migrationDir: "src/migrations/postgres",
      pg: requestScopedPg,
      pool: {
        // Reading the Hyperdrive connection string is I/O, which workerd forbids
        // while modules load (where this config is built), so defer it to connect.
        get connectionString() {
          return binding(env.HYPERDRIVE, "HYPERDRIVE").connectionString;
        },
      },
      // A preview schema is migrated by its build over a direct connection
      // with search_path set. Run here, through Hyperdrive, the migrations'
      // unqualified DDL would land in public, which every other preview reads.
      prodMigrations: schemaName ? undefined : migrations,
      push: false,
    };

    if (schemaName) {
      adapterArgs.schemaName = schemaName;
    }

    return postgresAdapter(adapterArgs);
  }

  const { sqliteD1Adapter } = await import("@payloadcms/db-d1-sqlite");

  // The demo's locales (src/demo-locales.ts) need another schema than the
  // committed migrations make. Their one migration is written from the
  // config each time the local database is set up, and nothing is applied
  // when the Worker boots.
  if (hasDemoLocales) {
    return sqliteD1Adapter({
      binding: timedD1(binding(env.D1, "D1")),
      migrationDir: `${DEMO_LOCALES_DIR}/migrations`,
      push: false,
    });
  }

  return sqliteD1Adapter({
    // Each query counts toward upstream.d1 on the request's wide event.
    binding: timedD1(binding(env.D1, "D1")),
    migrationDir: "src/migrations/d1",
    prodMigrations: d1Migrations,
    push: false,
  });
};
