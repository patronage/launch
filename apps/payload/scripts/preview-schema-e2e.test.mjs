// oxlint-disable vitest/prefer-importing-vitest-globals, func-style, no-await-in-loop -- An opt-in Node test runner suite that polls a container.
/**
 * Runs scripts/preview-schema.mjs from start to finish against a throwaway
 * Postgres 17 container standing in for the preview database: `public` is
 * migrated and seeded with the demo site, a user and a form submission, as the
 * shared preview copy would be. Nothing here contacts Cloudflare or PlanetScale.
 *
 * It fails unless `prepare` refuses a database `init` has not marked, sends a
 * branch without new migrations to the shared copy, and gives a branch with a
 * migration (scripts/fixtures/migrations/29991231_000000_preview_e2e.ts) its own schema,
 * where Payload reads exactly what it reads from the shared copy, the user
 * signs in, new documents get the next id, and the migration's table exists
 * only there. Preparing again migrates in place, and `drop` removes the schema.
 *
 * Run from apps/payload, after `pnpm install`, with a PAYLOAD_SECRET in the
 * environment or .env:
 *
 *   PREVIEW_SCHEMA_E2E=1 node --test scripts/preview-schema-e2e.test.mjs
 *
 * Without PREVIEW_SCHEMA_E2E=1 the suite is skipped. It needs Docker, and
 * starts one container named preview-schema-e2e-<pid> with --rm, removed with
 * `docker rm -fv` when it ends.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";

import { schemaForBranch } from "./preview-schema.mjs";

const APP_DIR = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(import.meta.dirname, "preview-schema.mjs");
const DUMP = "scripts/fixtures/dump-content.ts";
const EXTRA = "scripts/fixtures/d1-copy-e2e-extra.ts";

const BRANCH_MIGRATION =
  "scripts/fixtures/migrations/29991231_000000_preview_e2e.ts";

const enabled = process.env.PREVIEW_SCHEMA_E2E === "1";
const CONTAINER = `preview-schema-e2e-${process.pid}`;
const PASSWORD = "e2e-preview-pw";
const READY_ATTEMPTS = 60;
const READY_WAIT_MS = 1000;
const SUITE_TIMEOUT_MS = 900_000;
const MAX_BUFFER = 256 * 1024 * 1024;
const FEATURE = "feature/new-field";
const SCHEMA = schemaForBranch(FEATURE);

let dir = "";
let url = "";
let publicEnv = {};

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: APP_DIR,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    ...options,
  });

  assert.equal(
    result.status,
    0,
    `${program} ${args.join(" ")}:\n${result.stdout}\n${result.stderr}`
  );

  return result.stdout;
}

function psql(sql) {
  return command("docker", [
    "exec",
    CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-d",
    "launch_payload",
    "-At",
    "-c",
    sql,
  ]).trim();
}

function freePort() {
  const { promise, reject, resolve } = Promise.withResolvers();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });

  return promise;
}

async function untilReady() {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const ready = spawnSync("docker", [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "launch_payload",
      "-c",
      "select 1",
    ]);

    if (ready.status === 0) {
      return;
    }

    await sleep(READY_WAIT_MS);
  }

  throw new Error(`${CONTAINER} did not start`);
}

function preview(args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: APP_DIR,
    encoding: "utf-8",
    env: { ...publicEnv, PREVIEW_DATABASE_URL: url, ...extraEnv },
    maxBuffer: MAX_BUFFER,
  });
}

const withBranchMigration = {
  PREVIEW_MIGRATIONS_EXTRA: path.join(APP_DIR, BRANCH_MIGRATION),
};

/** Payload's view of every document, through the env's database and schema. */
function dump(env, name) {
  const file = path.join(dir, `${name}.json`);
  command("pnpm", ["-s", "payload", "run", DUMP, file], { env });

  return JSON.parse(readFileSync(file, "utf-8"));
}

before(
  async () => {
    if (!enabled) {
      return;
    }

    dir = mkdtempSync(path.join(tmpdir(), "preview-schema-e2e-"));
    const port = await freePort();
    url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/launch_payload`;

    const base = {
      ...process.env,
      PAYLOAD_LOCAL_STATE: path.join(dir, "state"),
    };

    delete base.PAYLOAD_DB_SCHEMA;
    delete base.PREVIEW_MIGRATIONS_EXTRA;
    publicEnv = { ...base, PAYLOAD_DB: "postgres", POSTGRES_URL: url };

    command("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER,
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-e",
      "POSTGRES_DB=launch_payload",
      "-p",
      `127.0.0.1:${port}:5432`,
      "postgres:17",
    ]);
    await untilReady();

    command("pnpm", ["-s", "payload", "migrate"], { env: publicEnv });
    command("pnpm", ["-s", "seed"], { env: publicEnv });
    command("pnpm", ["-s", "payload", "run", EXTRA], { env: publicEnv });
  },
  { timeout: SUITE_TIMEOUT_MS }
);

after(() => {
  if (!enabled) {
    return;
  }

  spawnSync("docker", ["rm", "-fv", CONTAINER]);
  rmSync(dir, { force: true, recursive: true });
});

test(
  "prepare refuses a database init has not marked as the preview database",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const run = preview(["prepare", "--branch", FEATURE], withBranchMigration);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a preview database\. Nothing was changed\./u);
    assert.equal(
      psql(
        `select count(*) from pg_namespace where nspname like 'preview\\_%'`
      ),
      "0"
    );

    const init = preview(["init"]);
    assert.equal(init.status, 0, init.stderr);
  }
);

test(
  "a branch without new migrations reads the shared copy",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const out = path.join(dir, "plain-schema");
    const run = preview(["prepare", "--branch", "fix/typo", "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /adds no migrations/u);
    assert.equal(readFileSync(out, "utf-8"), "");
    assert.equal(
      psql(
        `select count(*) from pg_namespace where nspname like 'preview\\_%'`
      ),
      "0"
    );
  }
);

test(
  "a branch with a migration gets its own copy, and public is untouched",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const publicMigrations = psql(
      "select count(*) from public.payload_migrations"
    );

    const out = path.join(dir, "feature-schema");

    const run = preview(
      ["prepare", "--branch", FEATURE, "--out", out],
      withBranchMigration
    );

    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(out, "utf-8"), SCHEMA);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(PASSWORD, "u"));

    assert.equal(
      psql(
        "select string_agg(table_schema, ',') from information_schema.tables where table_name = 'preview_e2e_notes'"
      ),
      SCHEMA
    );
    assert.equal(
      psql("select count(*) from public.payload_migrations"),
      publicMigrations
    );
    assert.equal(
      psql(`select count(*) from "${SCHEMA}".payload_migrations`),
      String(Number(publicMigrations) + 1)
    );
    // The branch's migration ran on the copied content.
    assert.equal(
      psql(`select count(*) from "${SCHEMA}".preview_e2e_notes`),
      psql("select count(*) from public.pages")
    );
    // Nothing in the copy points back into public.
    assert.equal(
      psql(`select count(*) from pg_constraint c
              join pg_class s on s.oid = c.conrelid join pg_namespace sn on sn.oid = s.relnamespace
              join pg_class t on t.oid = c.confrelid join pg_namespace tn on tn.oid = t.relnamespace
             where c.contype = 'f' and sn.nspname = '${SCHEMA}' and tn.nspname <> sn.nspname`),
      "0"
    );

    const fromPublic = dump(publicEnv, "public");

    const fromSchema = dump(
      { ...publicEnv, PAYLOAD_DB_SCHEMA: SCHEMA },
      "schema"
    );

    assert.ok(fromPublic.pages.length > 0 && fromPublic.users.length === 1);
    assert.deepEqual(fromSchema, fromPublic);
  }
);

test(
  "the copy's user signs in and new documents get the next id",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const schemaEnv = { ...publicEnv, PAYLOAD_DB_SCHEMA: SCHEMA };

    const ids = dump(schemaEnv, "before-check").categories.map(
      (category) => category.id
    );

    const publicCategories = psql("select count(*) from public.categories");

    const file = path.join(dir, "check.json");
    command("pnpm", ["-s", "payload", "run", EXTRA, "check", file], {
      env: schemaEnv,
    });
    const result = JSON.parse(readFileSync(file, "utf-8"));

    assert.equal(result.signedIn, true);
    assert.equal(result.categoryId, Math.max(...ids) + 1);
    assert.equal(
      psql("select count(*) from public.categories"),
      publicCategories
    );
  }
);

test(
  "preparing again keeps the schema, and drop removes it",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const again = preview(
      ["prepare", "--branch", FEATURE],
      withBranchMigration
    );

    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`Migrating ${SCHEMA}`, "u"));
    // The category the previous test created is still there: nothing was rebuilt.
    assert.equal(
      Number(psql(`select count(*) from "${SCHEMA}".categories`)),
      Number(psql("select count(*) from public.categories")) + 1
    );

    const sweep = preview(["sweep", "--days", "1", "--dry-run"]);
    assert.equal(sweep.status, 0, sweep.stderr);
    assert.doesNotMatch(sweep.stdout, /Would drop/u);

    const drop = preview(["drop", "--branch", FEATURE]);
    assert.equal(drop.status, 0, drop.stderr);
    assert.equal(
      psql(`select count(*) from pg_namespace where nspname = '${SCHEMA}'`),
      "0"
    );
    assert.equal(psql("select count(*) from launch_preview.schemas"), "0");
  }
);

test(
  "a schema an earlier run left half built is rebuilt",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    // What a build that died after creating the schema leaves: the schema,
    // part of a table, and the empty row written before the first migration.
    psql(`create schema "${SCHEMA}"`);
    psql(`create table "${SCHEMA}".pages (id serial primary key)`);
    psql(
      `insert into launch_preview.schemas values ('${SCHEMA}', '${FEATURE}', '{}', now())`
    );

    // As in Workers Builds, where the build has no PAYLOAD_SECRET.
    const run = preview(["prepare", "--branch", FEATURE], {
      ...withBranchMigration,
      PAYLOAD_SECRET: "",
    });

    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /an earlier run did not finish it/u);
    assert.equal(
      psql(`select count(*) from "${SCHEMA}".pages`),
      psql("select count(*) from public.pages")
    );
    assert.equal(
      psql(
        `select cardinality(migrations) > 0 from launch_preview.schemas where schema_name = '${SCHEMA}'`
      ),
      "t"
    );
  }
);

test(
  "sweep skips a schema a build is preparing, and drops it once free",
  { skip: !enabled && "set PREVIEW_SCHEMA_E2E=1", timeout: SUITE_TIMEOUT_MS },
  async () => {
    psql(
      `update launch_preview.schemas set last_used = now() - interval '30 days' where schema_name = '${SCHEMA}'`
    );

    const holder = new Client({ connectionString: url });
    await holder.connect();

    try {
      await holder.query("select pg_advisory_lock(hashtext($1))", [
        `launch_preview:${SCHEMA}`,
      ]);

      const busy = preview(["sweep", "--days", "7"]);
      assert.equal(busy.status, 0, busy.stderr);
      assert.match(busy.stdout, /a build is preparing it/u);
      assert.equal(
        psql(`select count(*) from pg_namespace where nspname = '${SCHEMA}'`),
        "1"
      );
    } finally {
      await holder.end();
    }

    const free = preview(["sweep", "--days", "7"]);
    assert.equal(free.status, 0, free.stderr);
    assert.match(free.stdout, new RegExp(`Dropping ${SCHEMA}`, "u"));
    assert.equal(
      psql(`select count(*) from pg_namespace where nspname = '${SCHEMA}'`),
      "0"
    );
  }
);
