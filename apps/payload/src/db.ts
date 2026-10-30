import { env } from "cloudflare:workers";
import type { Config } from "payload";

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
    const { postgresAdapter } = await import("@payloadcms/db-postgres");
    const { migrations } = await import("./migrations/postgres");
    const { requestScopedPg } = await import("./request-scoped-pg");

    return postgresAdapter({
      migrationDir: "src/migrations/postgres",
      pg: requestScopedPg,
      pool: {
        // Reading the Hyperdrive connection string is I/O, which workerd forbids
        // while modules load (where this config is built), so defer it to connect.
        get connectionString() {
          return binding(env.HYPERDRIVE, "HYPERDRIVE").connectionString;
        },
      },
      prodMigrations: migrations,
      push: false,
    });
  }

  const { sqliteD1Adapter } = await import("@payloadcms/db-d1-sqlite");

  return sqliteD1Adapter({
    binding: binding(env.D1, "D1"),
    migrationDir: "src/migrations/d1",
    prodMigrations: d1Migrations,
    push: false,
  });
};
