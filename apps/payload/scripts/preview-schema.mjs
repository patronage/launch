#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- Statements run one at a time, in order, inside one transaction. */
// Gives a branch preview the database it needs on the shared preview database
// (ADR 0021). Most branches add no migrations and read the shared copy in
// `public`. A branch that adds migrations gets its own schema, a copy of
// `public` with its migrations applied on top, so the shared copy stays as is.
//
//   node scripts/preview-schema.mjs init                       once per preview database
//   node scripts/preview-schema.mjs prepare --branch <name> [--out <file>]
//   node scripts/preview-schema.mjs drop --branch <name>
//   node scripts/preview-schema.mjs sweep --days <n> [--dry-run]
//
// PREVIEW_DATABASE_URL is a direct connection to the preview database (not
// Hyperdrive) as a role that inherits `postgres`. `prepare` prints the schema
// the Worker should be built with, or nothing for `public`, and writes it to
// --out when given.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

import { CopyError, SKIPPED_TABLES, copyPlan } from "./d1-to-postgres.mjs";

const SOURCE = "public";
const META = "launch_preview";

/**
 * Every schema, table and type this script creates belongs to postgres, not
 * to the role in PREVIEW_DATABASE_URL (which inherits postgres). PlanetScale
 * refuses to delete a role that still owns objects.
 */
const OWNER = "postgres";

/**
 * Hands what the connecting role created to postgres. Payload's migrations
 * open their own connections as that role, and PlanetScale ignores a `role`
 * startup option, so their tables and types are reassigned afterwards.
 */
const reassignToOwner = async (client) => {
  const { rows } = await client.query("select session_user as name");

  if (rows[0].name === OWNER) {
    return;
  }

  await client.query("reset role");
  await client.query(`reassign owned by session_user to ${OWNER}`);
  await client.query(`set role ${OWNER}`);
};

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../src/migrations/postgres"
);

/** The pattern src/db.ts accepts for PAYLOAD_DB_SCHEMA. */
export const SCHEMA_PATTERN = /^preview_[0-9a-f]{12}$/u;

/**
 * A branch's schema: a hash of its name, so any branch name maps to a short,
 * valid identifier that Postgres never truncates.
 */
export const schemaForBranch = (branch) => {
  if (!branch?.trim()) {
    throw new CopyError("A branch name is required.");
  }

  const hash = createHash("sha256").update(branch.trim()).digest("hex");

  return `preview_${hash.slice(0, 12)}`;
};

export const checkSchemaName = (name) => {
  if (!SCHEMA_PATTERN.test(name ?? "")) {
    throw new CopyError(
      `A preview schema looks like preview_<12 hex digits>, not "${name ?? ""}".`
    );
  }

  return name;
};

const ident = (name) => {
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new CopyError(`Unexpected identifier "${name}".`);
  }

  return `"${name}"`;
};

/**
 * The migrations this checkout has, oldest first. PREVIEW_MIGRATIONS_EXTRA
 * names one more migration file, for the e2e test (preview-migrate.ts runs it).
 */
export const checkoutMigrations = (
  dir = MIGRATIONS_DIR,
  extra = process.env.PREVIEW_MIGRATIONS_EXTRA
) =>
  [
    ...readdirSync(dir).filter((file) => /^\d{8}_\d{6}_.+\.ts$/u.test(file)),
    ...(extra ? [path.basename(extra)] : []),
  ]
    .map((file) => file.slice(0, -".ts".length))
    .toSorted();

/**
 * Which database a branch preview reads, from the migrations it has and the
 * ones the shared copy has.
 *
 * - `public`: the branch adds none. If it lacks some of the shared copy's
 *   migrations, it is behind main and reads a newer schema; `behind` says so.
 * - `schema`: the branch adds migrations on top of every one the shared copy has.
 */
export const decide = ({ branch, shared }) => {
  const sharedSet = new Set(shared);
  const added = branch.filter((name) => !sharedSet.has(name));
  const branchSet = new Set(branch);
  const missing = shared.filter((name) => !branchSet.has(name));

  if (added.length === 0) {
    return { behind: missing, mode: "public" };
  }

  if (missing.length > 0) {
    throw new CopyError(
      `This branch adds migrations (${added.join(", ")}) but lacks ones the shared preview copy has (${missing.join(", ")}). Merge main into the branch.`
    );
  }

  const newestShared = shared.at(-1);

  const early = newestShared ? added.filter((name) => name < newestShared) : [];

  if (early.length > 0) {
    throw new CopyError(
      `This branch's migrations ${early.join(", ")} sort before ${newestShared}, which the shared preview copy already has. Recreate them with \`pnpm payload migrate:create\` so they come last.`
    );
  }

  return { added, mode: "schema" };
};

const migrationNames = async (client, schema) => {
  const { rows } = await client.query(
    `select name from ${ident(schema)}.payload_migrations where batch <> -1 order by name`
  );

  return rows.map((row) => row.name);
};

const schemaExists = async (client, schema) => {
  const { rows } = await client.query(
    "select 1 from pg_namespace where nspname = $1",
    [schema]
  );

  return rows.length > 0;
};

/** Refuses any database `init` has not marked as a preview database. */
const assertPreviewDatabase = async (client) => {
  if (!(await schemaExists(client, META))) {
    throw new CopyError(
      `This database has no ${META} schema, so it is not a preview database. Nothing was changed. If it is the preview database, run \`node scripts/preview-schema.mjs init\` once.`
    );
  }
};

/** Tables, columns and foreign keys of one schema, from the catalog. */
export const readSchema = async (client, schema) => {
  const { rows: columns } = await client.query(
    `select c.relname as table_name, a.attname::text as column_name,
            t.typname::text as type_name, t.typtype::text as typtype,
            e.typname::text as elem_name, e.typtype::text as elem_typtype
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       join pg_type t on t.oid = a.atttypid
       left join pg_type e on e.oid = t.typelem and t.typcategory = 'A'
      where n.nspname = $1 and c.relkind = 'r'
      order by c.relname, a.attnum`,
    [schema]
  );

  const { rows: keys } = await client.query(
    `select s.relname::text as table_name, t.relname::text as target,
            array_agg(a.attname::text order by k.ord) as columns
       from pg_constraint c
       join pg_class s on s.oid = c.conrelid
       join pg_namespace n on n.oid = s.relnamespace
       join pg_class t on t.oid = c.confrelid
       cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and n.nspname = $1
      group by c.oid, s.relname, t.relname`,
    [schema]
  );

  const tables = new Map();

  for (const row of columns) {
    if (!tables.has(row.table_name)) {
      tables.set(row.table_name, {
        columns: [],
        foreignKeys: [],
        name: row.table_name,
      });
    }

    let enumType = null;

    if (row.typtype === "e") {
      enumType = { array: false, type: row.type_name };
    } else if (row.elem_typtype === "e") {
      enumType = { array: true, type: row.elem_name };
    }

    // Enums belong to a schema: public.enum_x and preview_….enum_x are
    // different types, so their values go across as text.
    tables
      .get(row.table_name)
      .columns.push({ enum: enumType, name: row.column_name });
  }

  for (const key of keys) {
    tables
      .get(key.table_name)
      ?.foreignKeys.push({ columns: key.columns, table: key.target });
  }

  return [...tables.values()];
};

const selectList = (table, target, deferred) =>
  table.columns.map((column) => {
    const name = ident(column.name);

    if (deferred.has(column.name)) {
      return "null";
    }

    if (column.enum) {
      const type = `${ident(target)}.${ident(column.enum.type)}`;

      return column.enum.array
        ? `${name}::text[]::${type}[]`
        : `${name}::text::${type}`;
    }

    return name;
  });

/**
 * Copies every row of `public` into `target`, in one transaction. Both must be
 * at the same migration level and `target` empty. Preview users come along:
 * the shared copy's users are preview editors, not production's.
 */
export const copySchema = async ({ client, log, target }) => {
  checkSchemaName(target);

  const [sourceLevel, targetLevel] = await Promise.all([
    migrationNames(client, SOURCE),
    migrationNames(client, target),
  ]);

  if (sourceLevel.join("\n") !== targetLevel.join("\n")) {
    throw new CopyError(
      `${target} is not at public's migration level. Migrate it to exactly: ${sourceLevel.join(", ")}.`
    );
  }

  const [sourceTables, targetTables] = await Promise.all([
    readSchema(client, SOURCE),
    readSchema(client, target),
  ]);

  const targetNames = new Set(targetTables.map((table) => table.name));
  const missing = sourceTables.filter((table) => !targetNames.has(table.name));

  if (missing.length > 0) {
    throw new CopyError(
      `${target} lacks tables public has: ${missing.map((table) => table.name).join(", ")}.`
    );
  }

  const plan = copyPlan(sourceTables);
  const counts = new Map();

  await client.query("begin");

  try {
    for (const table of plan) {
      const { rows } = await client.query(
        `select count(*)::int as n from ${ident(target)}.${ident(table.name)}`
      );

      if (rows[0].n > 0) {
        throw new CopyError(
          `${target}.${table.name} already has rows. Copy into a freshly migrated schema.`
        );
      }

      const deferred = new Set(table.deferred);
      const names = table.columns.map((column) => ident(column.name));

      const result = await client.query(
        `insert into ${ident(target)}.${ident(table.name)} (${names.join(", ")})
         select ${selectList(table, target, deferred).join(", ")}
           from ${SOURCE}.${ident(table.name)}`
      );

      for (const column of deferred) {
        await client.query(
          `update ${ident(target)}.${ident(table.name)} t
              set ${ident(column)} = s.${ident(column)}
             from ${SOURCE}.${ident(table.name)} s
            where t.id = s.id`
        );
      }

      counts.set(table.name, result.rowCount);
    }

    // Serial ids continue after the copied rows.
    const { rows: sequences } = await client.query(
      `select c.relname::text as table_name, a.attname::text as column_name,
              pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) as seq
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = $1 and c.relkind = 'r'
          and pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) is not null`,
      [target]
    );

    for (const row of sequences) {
      await client.query(
        `select setval($1, coalesce((select max(${ident(row.column_name)}) from ${ident(target)}.${ident(row.table_name)}), 0) + 1, false)`,
        [row.seq]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  log(
    `Copied ${total} rows in ${counts.size} tables from public into ${target} (not copied: ${[...SKIPPED_TABLES].join(", ")}).`
  );

  return counts;
};

/** The URL Payload migrates a schema through: search_path names the schema. */
export const schemaUrl = (url, schema) => {
  const parsed = new URL(url);

  parsed.searchParams.set(
    "options",
    `-c search_path=${checkSchemaName(schema)}`
  );

  return parsed.toString();
};

/**
 * Runs this checkout's migrations into `schema` with the Payload CLI, all of
 * them or only `only`. The committed migrations name no schema, so search_path
 * decides where they land.
 */
const migrateSchema = ({ only, schema, url }) => {
  const result = spawnSync(
    "pnpm",
    ["payload", "run", "scripts/preview-migrate.ts"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PAYLOAD_DB: "postgres",
        PAYLOAD_DB_SCHEMA: schema,
        POSTGRES_URL: schemaUrl(url, schema),
        PREVIEW_MIGRATE_ONLY: only ? JSON.stringify(only) : "",
      },
      stdio: "inherit",
    }
  );

  if (result.status !== 0) {
    throw new CopyError(`Migrating ${schema} failed.`);
  }
};

const record = (client, { branch, migrations, schema }) =>
  client.query(
    `insert into ${META}.schemas (schema_name, branch, migrations, last_used)
     values ($1, $2, $3, now())
     on conflict (schema_name) do update
       set branch = excluded.branch, migrations = excluded.migrations, last_used = now()`,
    [schema, branch, migrations]
  );

const dropSchema = async (client, schema) => {
  checkSchemaName(schema);
  await client.query(`drop schema if exists ${ident(schema)} cascade`);
  await client.query(`delete from ${META}.schemas where schema_name = $1`, [
    schema,
  ]);
};

/**
 * Makes the branch's database ready and returns the schema to build with, or
 * "" for the shared copy in public.
 */
export const prepare = async ({
  branch,
  client,
  log,
  migrate = migrateSchema,
  migrations = checkoutMigrations(),
  url,
}) => {
  await assertPreviewDatabase(client);

  const shared = await migrationNames(client, SOURCE);

  if (shared.length === 0) {
    throw new CopyError(
      "The shared preview copy in public has no migrations. Copy content into it first."
    );
  }

  const decision = decide({ branch: migrations, shared });

  if (decision.mode === "public") {
    if (decision.behind.length > 0) {
      log(
        `This branch lacks migrations the shared copy has (${decision.behind.join(", ")}); it reads the newer shared copy. Merge main to match.`
      );
    }

    log(`${branch} adds no migrations: its preview reads the shared copy.`);

    return "";
  }

  const schema = schemaForBranch(branch);

  if (await schemaExists(client, schema)) {
    const existing = await migrationNames(client, schema);
    const wanted = new Set(migrations);

    const sharedPrefix = shared.every(
      (name, index) => existing[index] === name
    );

    // A schema built from an older shared copy, or holding migrations this
    // branch no longer has, is rebuilt rather than patched.
    if (!sharedPrefix || existing.some((name) => !wanted.has(name))) {
      log(`Rebuilding ${schema}: its migrations no longer match this branch.`);
      await dropSchema(client, schema);
    }
  }

  if (await schemaExists(client, schema)) {
    log(`Migrating ${schema} for ${branch}.`);
  } else {
    log(
      `Creating ${schema} for ${branch}, which adds ${decision.added.join(", ")}.`
    );
    await client.query(`create schema ${ident(schema)}`);
    await record(client, { branch, migrations: [], schema });
    migrate({ only: shared, schema, url });
    await copySchema({ client, log, target: schema });
  }

  migrate({ schema, url });
  await reassignToOwner(client);

  await record(client, {
    branch,
    migrations: await migrationNames(client, schema),
    schema,
  });

  return schema;
};

/** Drops schemas not prepared for `days` days. */
export const sweep = async ({ client, days, dryRun = false, log }) => {
  await assertPreviewDatabase(client);

  const { rows } = await client.query(
    `select schema_name, branch, last_used from ${META}.schemas
      where last_used < now() - make_interval(days => $1)
      order by last_used`,
    [days]
  );

  for (const row of rows) {
    log(
      `${dryRun ? "Would drop" : "Dropping"} ${row.schema_name} (${row.branch}, last prepared ${row.last_used.toISOString()}).`
    );

    if (!dryRun) {
      await dropSchema(client, row.schema_name);
    }
  }

  return rows.map((row) => row.schema_name);
};

export const init = async ({ client, log }) => {
  await client.query(`create schema if not exists ${META}`);
  await client.query(
    `create table if not exists ${META}.schemas (
       schema_name text primary key,
       branch text not null,
       migrations text[] not null,
       last_used timestamptz not null
     )`
  );
  log(`Marked this database as the preview database (${META}).`);
};

const option = (args, name) => {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  const commands = new Set(["drop", "init", "prepare", "sweep"]);

  if (!commands.has(command)) {
    throw new CopyError(
      "Usage: preview-schema.mjs init | prepare --branch <name> [--out <file>] | drop --branch <name> | sweep --days <n> [--dry-run]"
    );
  }

  const branch = option(args, "--branch");
  const days = Number(option(args, "--days"));

  if ((command === "prepare" || command === "drop") && !branch) {
    throw new CopyError(`${command} needs --branch <name>.`);
  }

  if (command === "sweep" && !(Number.isInteger(days) && days > 0)) {
    throw new CopyError("sweep needs --days <whole number of days>.");
  }

  const url = process.env.PREVIEW_DATABASE_URL;

  if (!url) {
    throw new CopyError(
      "PREVIEW_DATABASE_URL (a direct connection to the preview database) is required."
    );
  }

  const client = new Client({ connectionString: url });

  await client.connect();
  await client.query(`set role ${OWNER}`);

  try {
    if (command === "init") {
      await init({ client, log: console.log });
    } else if (command === "prepare") {
      const schema = await prepare({ branch, client, log: console.log, url });
      const out = option(args, "--out");

      if (out) {
        writeFileSync(out, schema);
      }

      console.log(`PAYLOAD_DB_SCHEMA=${schema}`);
    } else if (command === "drop") {
      await assertPreviewDatabase(client);
      await dropSchema(client, schemaForBranch(branch));
      console.log(`Dropped ${schemaForBranch(branch)} (${branch}).`);
    } else {
      await sweep({
        client,
        days,
        dryRun: args.includes("--dry-run"),
        log: console.log,
      });
    }
  } finally {
    await client.end();
  }
};

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    if (error instanceof CopyError) {
      process.stderr.write(`preview-schema: ${error.message}
`);
      process.exit(1);
    }

    throw error;
  }
}
