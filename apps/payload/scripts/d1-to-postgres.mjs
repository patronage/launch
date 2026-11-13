#!/usr/bin/env node
/* oxlint-disable no-await-in-loop, anti-slop/no-runtime-typeof -- The copy runs one statement at a time inside one transaction, and SQLite hands back untyped values that are converted by the Postgres column type they land in. */
// pnpm d1:copy --target <postgres-url> [--local | --sqlite <file>] [--dry-run]
//
// Copies the content of the Payload D1 database into an empty, migrated
// Postgres database, for the move from D1 to Postgres through Hyperdrive.
// The D1 and Postgres migrations build the same tables and columns, so the
// copy is table by table: the same rows, the same ids.
//
// 1. Reads the source: production D1 through `cf d1 query` (read-only
//    SELECTs, signed in with the cf CLI), or with --local the local D1 that
//    `pnpm payload migrate` and `pnpm seed` write, or with --sqlite a SQLite
//    file.
// 2. Checks that both sides have run the same migrations as this checkout and
//    that every table it copies is empty on the target.
// 3. In one transaction on the target: inserts every table in foreign-key
//    order (pages.parent_id and other links to the same table are filled in
//    afterwards), turns SQLite's 0/1 into booleans, resets each serial
//    sequence past the copied ids, compares every table's row count with the
//    source and commits only if all match.
//
// Sessions, document locks and the key-value cache are not copied, so editors
// sign in again. Rows go from the source to the target in memory and are
// never written to disk or printed. --dry-run reads the source's row counts
// and checks the target, and writes nothing.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const APP_DIR = path.join(import.meta.dirname, "..");

const MIGRATIONS = {
  d1: path.join(APP_DIR, "src", "migrations", "d1"),
  postgres: path.join(APP_DIR, "src", "migrations", "postgres"),
};

const LOCAL_D1_DIR = path.join(
  APP_DIR,
  ".cloudflare",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject"
);

/** Tables the copy leaves behind: per-session or rebuilt on demand. */
export const SKIPPED_TABLES = new Set([
  "payload_kv",
  "payload_locked_documents",
  "payload_locked_documents_rels",
  "payload_migrations",
  "users_sessions",
]);

const PAGE_SIZE = 500;
const MAX_PARAMS = 30_000;

export class CopyError extends Error {
  name = "CopyError";
}

const quote = (name) => {
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new CopyError(`Unexpected identifier "${name}".`);
  }

  return `"${name}"`;
};

/** Migration names without their timestamps: D1 and Postgres differ there. */
export const migrationKey = (name) => name.replace(/^\d{8}_\d{6}_/u, "");

const migrationFiles = (dir) =>
  readdirSync(dir)
    .filter((file) => /^\d{8}_\d{6}_.+\.ts$/u.test(file))
    .map((file) => file.slice(0, -".ts".length))
    .toSorted();

/** The Postgres schema the migrations build, from the newest snapshot. */
export const loadSchema = (dir = MIGRATIONS.postgres) => {
  const newest = readdirSync(dir)
    .filter((file) => /^\d{8}_\d{6}_.+\.json$/u.test(file))
    .toSorted()
    .at(-1);

  if (!newest) {
    throw new CopyError(`No migration snapshot in ${dir}.`);
  }

  const snapshot = JSON.parse(readFileSync(path.join(dir, newest), "utf-8"));

  return Object.values(snapshot.tables).map((table) => ({
    columns: Object.values(table.columns).map((column) => ({
      name: column.name,
      type: column.type,
    })),
    foreignKeys: Object.values(table.foreignKeys ?? {}).map((key) => ({
      columns: key.columnsFrom,
      table: key.tableTo,
    })),
    name: table.name,
  }));
};

/**
 * The tables to copy, each after the tables it points at. Links to the same
 * table are left out of the order and returned as `deferred` columns, which
 * the copy fills in once every row exists.
 */
export const copyPlan = (schema) => {
  const tables = new Map(
    schema
      .filter((table) => !SKIPPED_TABLES.has(table.name))
      .map((table) => [table.name, table])
  );

  const ordered = [];
  const state = new Map();

  const visit = (name, trail) => {
    if (state.get(name) === "done") {
      return;
    }

    if (state.get(name) === "visiting") {
      throw new CopyError(
        `Foreign keys form a cycle: ${[...trail, name].join(" -> ")}.`
      );
    }

    state.set(name, "visiting");

    for (const key of tables.get(name).foreignKeys) {
      if (key.table === name) {
        continue;
      }

      if (!tables.has(key.table)) {
        throw new CopyError(
          `${name} points at ${key.table}, which the copy skips.`
        );
      }

      visit(key.table, [...trail, name]);
    }

    state.set(name, "done");
    ordered.push(name);
  };

  for (const name of [...tables.keys()].toSorted()) {
    visit(name, []);
  }

  return ordered.map((name) => {
    const table = tables.get(name);

    const deferred = table.foreignKeys
      .filter((key) => key.table === name)
      .flatMap((key) => key.columns);

    return { ...table, deferred };
  });
};

/** One SQLite value as Postgres expects it for a column of `type`. */
export const convert = (value, type) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (type === "boolean") {
    if (value === 0 || value === 1 || value === "0" || value === "1") {
      return Number(value) === 1;
    }

    if (typeof value === "boolean") {
      return value;
    }

    throw new CopyError(`Expected 0 or 1 for a boolean, got ${typeof value}.`);
  }

  if (type === "jsonb" || type === "json") {
    if (typeof value === "string") {
      // Throws on text that is not JSON, rather than storing it as a string.
      JSON.parse(value);

      return value;
    }

    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
};

// --- Sources -----------------------------------------------------------------

/** A SQLite file: the local D1, or a copy of one. Opened read-only. */
export const sqliteSource = async (file) => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });

  return {
    close: () => db.close(),
    count: (table) =>
      Number(db.prepare(`select count(*) as n from ${quote(table)}`).get().n),
    describe: `the SQLite file ${path.relative(process.cwd(), file)}`,
    migrations: () =>
      db
        .prepare("select name from payload_migrations where batch <> -1")
        .all()
        .map((row) => row.name),
    rows: (table, offset, limit) =>
      db
        .prepare(
          `select * from ${quote(table)} order by rowid limit ? offset ?`
        )
        .all(limit, offset),
  };
};

/** Parses `cf d1 query` output: the API's results, with or without envelope. */
export const parseCfQuery = (stdout) => {
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : (parsed.result ?? [parsed]);
  const [first] = Array.isArray(list) ? list : [list];

  if (!(first && Array.isArray(first.results))) {
    throw new CopyError("cf d1 query returned no results array.");
  }

  if (first.success === false) {
    throw new CopyError("cf d1 query reported a failed query.");
  }

  return first.results;
};

/** Production D1 through `cf d1 query`: SELECTs only, one page at a time. */
export const cfSource = (databaseId, spawn = spawnSync) => {
  const query = (sql, params = []) => {
    const args = ["exec", "cf", "d1", "query", databaseId, "--sql", sql];

    if (params.length > 0) {
      args.push("--params", ...params.map(String));
    }

    const result = spawn("pnpm", args, {
      cwd: APP_DIR,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status !== 0) {
      throw new CopyError(
        `cf d1 query failed (exit ${result.status}). Is the cf CLI signed in? ${(result.stderr ?? "").trim().split("\n").at(-1) ?? ""}`
      );
    }

    return parseCfQuery(result.stdout);
  };

  return {
    // Each query is its own cf process; there is nothing to close.
    close: () => null,
    count: (table) =>
      Number(query(`select count(*) as n from ${quote(table)}`)[0].n),
    describe: `D1 database ${databaseId}`,
    migrations: () =>
      query("select name from payload_migrations where batch <> -1").map(
        (row) => row.name
      ),
    rows: (table, offset, limit) =>
      query(`select * from ${quote(table)} order by rowid limit ? offset ?`, [
        limit,
        offset,
      ]),
  };
};

/** The one local D1 file Miniflare keeps for this app. */
export const localD1File = (dir = LOCAL_D1_DIR) => {
  let files;

  try {
    files = readdirSync(dir).filter(
      (file) => file.endsWith(".sqlite") && file !== "metadata.sqlite"
    );
  } catch {
    throw new CopyError(
      `No local D1 in ${dir}. Run 'pnpm payload migrate' (and 'pnpm seed') first.`
    );
  }

  if (files.length !== 1) {
    throw new CopyError(
      `Expected one local D1 file in ${dir}, found ${files.length}. Pass --sqlite <file>.`
    );
  }

  return path.join(dir, files[0]);
};

// --- Copy --------------------------------------------------------------------

const checkMigrations = (sourceNames, targetNames) => {
  const d1 = migrationFiles(MIGRATIONS.d1).map(migrationKey);
  const postgres = migrationFiles(MIGRATIONS.postgres);
  const problems = [];

  if (d1.join(",") !== postgres.map(migrationKey).join(",")) {
    problems.push(
      "src/migrations/d1 and src/migrations/postgres do not have the same migrations."
    );
  }

  const source = sourceNames.map(migrationKey).toSorted();

  if (source.join(",") !== [...d1].toSorted().join(",")) {
    problems.push(
      `the source has run [${source.join(", ")}], this checkout's D1 migrations are [${d1.join(", ")}].`
    );
  }

  const target = targetNames.toSorted();

  if (target.join(",") !== postgres.join(",")) {
    problems.push(
      `the target has run [${target.join(", ")}], this checkout's Postgres migrations are [${postgres.join(", ")}]. Run 'PAYLOAD_DB=postgres POSTGRES_URL=<target> pnpm payload migrate' first.`
    );
  }

  if (problems.length > 0) {
    throw new CopyError(`Migrations differ: ${problems.join(" ")}`);
  }
};

const insertRows = async (client, table, columns, rows) => {
  const perBatch = Math.max(
    1,
    Math.min(PAGE_SIZE, Math.floor(MAX_PARAMS / columns.length))
  );

  for (let start = 0; start < rows.length; start += perBatch) {
    const batch = rows.slice(start, start + perBatch);
    const params = [];

    const tuples = batch.map((row) => {
      const slots = row.map((value) => {
        params.push(value);

        return `$${params.length}`;
      });

      return `(${slots.join(", ")})`;
    });

    await client.query(
      `insert into ${quote(table)} (${columns.map((column) => quote(column)).join(", ")}) values ${tuples.join(", ")}`,
      params
    );
  }
};

/**
 * Copies every planned table from `source` into the Postgres `client`, in one
 * transaction. Returns the row count of each table.
 */
export const copy = async ({ client, dryRun = false, log, plan, source }) => {
  const sourceMigrations = source.migrations();

  const { rows: targetMigrationRows } = await client.query(
    "select name from payload_migrations where batch <> -1"
  );

  checkMigrations(
    sourceMigrations,
    targetMigrationRows.map((row) => row.name)
  );

  const counts = new Map();

  for (const table of plan) {
    counts.set(table.name, source.count(table.name));
  }

  const notEmpty = [];

  for (const table of plan) {
    const { rows } = await client.query(
      `select count(*)::int as n from ${quote(table.name)}`
    );

    if (rows[0].n > 0) {
      notEmpty.push(`${table.name} (${rows[0].n})`);
    }
  }

  if (notEmpty.length > 0) {
    throw new CopyError(
      `The target already has rows in: ${notEmpty.join(", ")}. Copy into a freshly migrated database.`
    );
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  log(`${plan.length} tables, ${total} rows to copy from ${source.describe}.`);

  if (dryRun) {
    for (const table of plan) {
      log(`  ${table.name}: ${counts.get(table.name)}`);
    }

    log("Dry run: nothing was written.");

    return counts;
  }

  await client.query("begin");

  try {
    for (const table of plan) {
      const expected = counts.get(table.name);
      const names = table.columns.map((column) => column.name);

      const types = new Map(
        table.columns.map((column) => [column.name, column.type])
      );

      const deferred = new Set(table.deferred);
      const links = [];

      for (let offset = 0; offset < expected; offset += PAGE_SIZE) {
        const page = source.rows(table.name, offset, PAGE_SIZE);

        for (const row of page) {
          const unknown = Object.keys(row).filter((key) => !types.has(key));

          if (unknown.length > 0) {
            throw new CopyError(
              `${table.name} has columns the Postgres schema lacks: ${unknown.join(", ")}.`
            );
          }

          if (deferred.size > 0) {
            links.push(row);
          }
        }

        await insertRows(
          client,
          table.name,
          names,
          page.map((row) =>
            names.map((name) =>
              deferred.has(name) ? null : convert(row[name], types.get(name))
            )
          )
        );
      }

      for (const row of links) {
        for (const column of deferred) {
          if (row[column] !== null && row[column] !== undefined) {
            await client.query(
              `update ${quote(table.name)} set ${quote(column)} = $1 where id = $2`,
              [
                convert(row[column], types.get(column)),
                convert(row.id, types.get("id")),
              ]
            );
          }
        }
      }

      if (types.get("id") === "serial") {
        await client.query(
          `select setval(pg_get_serial_sequence($1, 'id'), coalesce(max(id), 1), max(id) is not null) from ${quote(table.name)}`,
          [table.name]
        );
      }

      const { rows } = await client.query(
        `select count(*)::int as n from ${quote(table.name)}`
      );

      if (rows[0].n !== expected) {
        throw new CopyError(
          `${table.name}: copied ${rows[0].n} rows, the source has ${expected}.`
        );
      }

      log(`  ${table.name}: ${expected}`);
    }

    await client.query("commit");
  } catch (error) {
    // The rollback can fail only if the connection is gone, which ends the
    // transaction anyway; report the error that caused it.
    await client.query("rollback").catch(() => null);
    throw error;
  }

  log(`Copied ${total} rows. Every table's count matches the source.`);

  return counts;
};

// --- CLI ---------------------------------------------------------------------

const masked = (uri) => {
  const url = new URL(uri);

  if (url.password) {
    url.password = "***";
  }

  return url.href;
};

/** The production D1 id, read from the binding in cloudflare.config.ts. */
export const productionD1Id = () => {
  const config = readFileSync(
    path.join(APP_DIR, "cloudflare.config.ts"),
    "utf-8"
  );

  const match = config.match(
    /id:\s*"(?<id>[0-9a-f-]{36})",\s*name:\s*"launch-payload"/u
  );

  if (!match) {
    throw new CopyError("Could not find the D1 id in cloudflare.config.ts.");
  }

  return match.groups.id;
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      local: { type: "boolean" },
      sqlite: { type: "string" },
      target: { type: "string" },
    },
  });

  const target = values.target ?? process.env.D1_COPY_TARGET_URL;

  if (!target) {
    throw new CopyError(
      "Pass --target <postgres-url> (or set D1_COPY_TARGET_URL): an empty database that 'pnpm payload migrate' has migrated."
    );
  }

  if (values.local && values.sqlite) {
    throw new CopyError("Pass --local or --sqlite, not both.");
  }

  const sqliteFile = values.sqlite ?? (values.local ? localD1File() : null);

  const source = sqliteFile
    ? await sqliteSource(sqliteFile)
    : cfSource(productionD1Id());

  const { Client } = await import("pg");

  const client = new Client({
    connectionString: target,
    connectionTimeoutMillis: 15_000,
  });

  console.log(`Target: ${masked(target)}`);
  await client.connect();

  try {
    await copy({
      client,
      dryRun: values["dry-run"] === true,
      log: (line) => console.log(line),
      plan: copyPlan(loadSchema()),
      source,
    });
  } finally {
    source.close();
    await client.end();
  }
};

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    if (error instanceof CopyError) {
      process.stderr.write(`d1-to-postgres: ${error.message}\n`);
      process.exit(1);
    }

    throw error;
  }
}
