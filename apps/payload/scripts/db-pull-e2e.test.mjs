// oxlint-disable vitest/prefer-importing-vitest-globals, func-style, no-use-before-define, no-await-in-loop -- An opt-in Node test runner suite that polls containers one at a time.
/**
 * Runs `pnpm db:pull` (packages/db-pull/pull-postgres.sh with this app's
 * db-pull.env, db-pull.tables and after-script) from start to finish with
 * real Docker, real pg_dump and pg_restore, and the real Payload CLI. Nothing
 * here contacts PlanetScale: the source is a throwaway Postgres 17 container
 * with TLS, migrated and seeded with the demo site, and `pscale` is a
 * stand-in that creates and drops real roles on it.
 *
 * It fails when a dump, or the local copy, holds anything that must stay in
 * PlanetScale: fixtures/db-pull-e2e-sensitive.sql adds users, a session, a
 * form submission, a form's notification email, a preference and a
 * key-value row, each marked MUSTNOTLEAVE.
 *
 * Run from apps/payload, after `pnpm install`, with a PAYLOAD_SECRET in the
 * environment or .env:
 *
 *   DB_PULL_E2E=1 node --test scripts/db-pull-e2e.test.mjs
 *
 * Without DB_PULL_E2E=1 the suite is skipped. It needs Docker on this machine,
 * where a container reaches the host as host.docker.internal (Docker Desktop,
 * OrbStack), and openssl. It starts two containers named db-pull-e2e-*-<pid>
 * with --rm and removes them with `docker rm -fv` when it ends.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const APP_DIR = path.join(import.meta.dirname, "..");

const SCRIPT = path.join(
  APP_DIR,
  "..",
  "..",
  "packages",
  "db-pull",
  "pull-postgres.sh"
);

const SENSITIVE = path.join(
  import.meta.dirname,
  "fixtures",
  "db-pull-e2e-sensitive.sql"
);

const enabled = process.env.DB_PULL_E2E === "1";
const SOURCE = `db-pull-e2e-src-${process.pid}`;
const TARGET = `db-pull-e2e-dst-${process.pid}`;
const TARGET_DB = "launch_payload";
const SOURCE_PASSWORD = "e2e-source-pw";
const TARGET_PASSWORD = "e2e-target-pw";
const READY_ATTEMPTS = 60;
const READY_WAIT_MS = 1000;
const RUN_TIMEOUT_MS = 300_000;
const SUITE_TIMEOUT_MS = 900_000;
const MAX_BUFFER = 256 * 1024 * 1024;

// Starts Postgres with TLS, using the certificate mounted at /certs.
const TLS_POSTGRES = [
  "cp /certs/server.crt /certs/server.key /var/lib/postgresql/",
  "chown postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key",
  "chmod 600 /var/lib/postgresql/server.key",
  "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key",
].join(" && ");

let dir = "";
let sourcePort = 0;
let targetPort = 0;

/** The pull's result, and its two dumps as pg_restore prints them. */
let run;
let schemaText = "";
let rowsText = "";

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
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

/** Runs SQL in a container's database and returns the rows as lines. */
function sql(container, database, statement) {
  return command("docker", [
    "exec",
    container,
    "psql",
    "-U",
    "root",
    "-d",
    database,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    statement,
  ])
    .split("\n")
    .filter(Boolean);
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

async function untilReady(container) {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const ready = spawnSync("docker", [
      "exec",
      container,
      "psql",
      "-U",
      "root",
      "-d",
      "postgres",
      "-c",
      "select 1",
    ]);

    if (ready.status === 0) {
      return;
    }

    await sleep(READY_WAIT_MS);
  }

  throw new Error(`${container} did not start`);
}

/** A CA, and a server certificate for host.docker.internal signed by it. */
function makeCertificates(certs) {
  const openssl = (...args) => command("openssl", args, { cwd: certs });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-subj",
    "/CN=db-pull-e2e CA"
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=host.docker.internal"
  );
  writeFileSync(
    path.join(certs, "san.ext"),
    "subjectAltName=DNS:host.docker.internal\n"
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    "san.ext",
    "-out",
    "server.crt"
  );
  // The container copies the key and gives it to the postgres user.
  chmodSync(path.join(certs, "server.key"), 0o644);
}

/**
 * Puts two programs in front of the real ones on PATH:
 *
 * - `pscale`: `role list`, `role create` and `role delete` act on real roles
 *   of the source container. A created role is a member of pg_read_all_data
 *   only, as on PlanetScale.
 * - `docker`: the real one, except that it keeps a copy of what each pg_dump
 *   wrote (dump.copy.1, dump.copy.2), so the test can read what left the
 *   source.
 */
function makeStandIns(bin) {
  const realDocker = command("sh", ["-c", "command -v docker"]).trim();
  writeFileSync(
    path.join(bin, "pscale"),
    `#!/bin/bash
set -euo pipefail
[ "$1" = "role" ] || exit 1
[ "$3" = "launch-payload" ] && [ "$4" = "main" ] || exit 1
command="$2"
shift 4
query() {
  "${realDocker}" exec -i ${SOURCE} psql -U root -d postgres --no-psqlrc \\
    --tuples-only --no-align --set ON_ERROR_STOP=1 "$@"
}
case "$command" in
  list)
    query -c "select coalesce(json_agg(json_build_object('id', rolname, 'name', rolname)), '[]') from pg_roles where rolname like 'db-pull-%'"
    ;;
  create)
    query -c "create role \\"$1\\" login password 'e2e-role-pw' in role pg_read_all_data" >/dev/null
    printf '{"id":"%s","name":"%s","username":"%s","password":"e2e-role-pw","access_host_url":"host.docker.internal:${sourcePort}"}\\n' "$1" "$1" "$1"
    ;;
  delete)
    query -c "drop role \\"$1\\"" >/dev/null
    ;;
  *) exit 1 ;;
esac
`
  );
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
case " $* " in
  *" pg_dump "*)
    echo x >>"${dir}/dump.count"
    copy="${dir}/dump.copy.$(wc -l <"${dir}/dump.count" | tr -d ' ')"
    "${realDocker}" "$@" >"$copy"
    status=$?
    cat "$copy"
    exit "$status"
    ;;
esac
exec "${realDocker}" "$@"
`
  );
  chmodSync(path.join(bin, "pscale"), 0o755);
  chmodSync(path.join(bin, "docker"), 0o755);
}

/** db-pull.tables, as `pnpm db:pull --list-tables` prints it. */
function listedTables() {
  const lists = { content: [], excluded: [] };

  for (const line of command("bash", [SCRIPT, "--list-tables"], {
    cwd: APP_DIR,
  })
    .split("\n")
    .filter(Boolean)) {
    const [kind, table] = line.split(" ");
    lists[kind].push(table);
  }

  return lists;
}

/** The tables of the copy that hold at least one row. */
function tablesWithRows() {
  const tables = sql(
    TARGET,
    TARGET_DB,
    "select tablename from pg_tables where schemaname = 'public' order by 1"
  );

  return sql(
    TARGET,
    TARGET_DB,
    tables
      .map(
        (table) => `select '${table}' where exists (select 1 from "${table}")`
      )
      .join(" union all ")
  );
}

/** Runs the Payload CLI against the source container. */
function payloadOnSource(...args) {
  command("pnpm", ["payload", ...args], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PAYLOAD_DB: "postgres",
      POSTGRES_URL: `postgres://root:${SOURCE_PASSWORD}@localhost:${sourcePort}/postgres`,
    },
  });
}

before(
  async () => {
    if (!enabled) {
      return;
    }

    dir = mkdtempSync(path.join(tmpdir(), "db-pull-e2e-"));
    const certs = path.join(dir, "certs");
    const bin = path.join(dir, "bin");
    mkdirSync(certs);
    mkdirSync(bin);
    makeCertificates(certs);
    sourcePort = await freePort();
    targetPort = await freePort();

    for (const [name, port, password, extra] of [
      [
        SOURCE,
        sourcePort,
        SOURCE_PASSWORD,
        ["-v", `${certs}:/certs:ro`, "postgres:17", "sh", "-c", TLS_POSTGRES],
      ],
      [TARGET, targetPort, TARGET_PASSWORD, ["postgres:17"]],
    ]) {
      command("docker", [
        "run",
        "--rm",
        "-d",
        "--name",
        name,
        "-e",
        "POSTGRES_USER=root",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=postgres",
        "-p",
        `127.0.0.1:${port}:5432`,
        ...extra,
      ]);
    }

    await untilReady(SOURCE);
    await untilReady(TARGET);
    // The image restarts Postgres once while it initializes.
    await sleep(READY_WAIT_MS * 2);
    await untilReady(SOURCE);
    await untilReady(TARGET);

    // The source: this checkout's schema, the demo site, then rows that must
    // stay behind.
    payloadOnSource("migrate");
    payloadOnSource("run", "scripts/seed.ts");
    command(
      "docker",
      [
        "exec",
        "-i",
        SOURCE,
        "psql",
        "-U",
        "root",
        "-d",
        "postgres",
        "--no-psqlrc",
        "--quiet",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      { input: readFileSync(SENSITIVE, "utf-8") }
    );
    // The developer's local database, which the run replaces.
    sql(TARGET, "postgres", `create database "${TARGET_DB}"`);
    sql(TARGET, TARGET_DB, "create table old_local_marker (id integer)");

    makeStandIns(bin);
    run = spawnSync("bash", [SCRIPT], {
      cwd: APP_DIR,
      encoding: "utf-8",
      env: {
        ...process.env,
        // A shell that points the CLI at somewhere else must not matter.
        PAYLOAD_DB: "d1",
        POSTGRES_URL: "postgres://someone:pw@db.example.invalid:5432/prod",
        PATH: `${bin}:${process.env.PATH}`,
        PULL_DB_TARGET_URL: `postgres://root:${TARGET_PASSWORD}@localhost:${targetPort}/${TARGET_DB}`,
        SSL_CERT_FILE: path.join(certs, "ca.pem"),
      },
      maxBuffer: MAX_BUFFER,
      timeout: RUN_TIMEOUT_MS,
    });

    // The two dumps as SQL text, read with the image's own pg_restore.
    const asText = (file) =>
      command(
        "docker",
        ["run", "--rm", "-i", "postgres:17", "pg_restore", "--file=-"],
        { input: readFileSync(path.join(dir, file)) }
      );

    schemaText = asText("dump.copy.1");
    rowsText = asText("dump.copy.2");
  },
  { timeout: SUITE_TIMEOUT_MS }
);

after(() => {
  if (!enabled) {
    return;
  }

  for (const container of [SOURCE, TARGET]) {
    spawnSync("docker", ["rm", "-fv", container]);
  }

  if (dir) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test(
  "the pull succeeds and replaces the local database",
  {
    skip: !enabled,
  },
  () => {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Leaving the rows of 16 tables in PlanetScale\./u);
    assert.match(
      run.stdout,
      /Checked: the copy holds rows in content tables only\./u
    );
    assert.match(
      run.stdout,
      /payload_migrations matches src\/migrations\/postgres/u
    );
    assert.match(run.stdout, /The copy has no users\./u);
    assert.ok(!run.stderr.includes("does not classify"), run.stderr);
    assert.deepEqual(
      sql(TARGET, TARGET_DB, "select to_regclass('old_local_marker') is null"),
      ["t"]
    );
    // The role is gone, and the source still has its own rows.
    assert.deepEqual(
      sql(
        SOURCE,
        "postgres",
        "select count(*) from pg_roles where rolname like 'db-pull-%'"
      ),
      ["0"]
    );
    assert.deepEqual(sql(SOURCE, "postgres", "select count(*) from users"), [
      "2",
    ]);
  }
);

test(
  "nothing that must stay in PlanetScale is in the dump",
  {
    skip: !enabled,
  },
  () => {
    for (const text of [schemaText, rowsText]) {
      assert.ok(!text.toLowerCase().includes("mustnotleave"));
    }

    // The first dump has every table and no rows at all.
    assert.ok(!schemaText.includes("COPY public."));
    const { content, excluded } = listedTables();

    for (const table of excluded) {
      assert.ok(schemaText.includes(`CREATE TABLE public.${table} (`), table);
      assert.ok(!rowsText.includes(`COPY public.${table} (`), table);
    }

    // The second dump has rows of content tables only.
    const copied = [
      ...rowsText.matchAll(/^COPY public\.(?<table>\S+) \(/gmu),
    ].map((match) => match.groups.table);

    assert.ok(copied.includes("pages"));
    assert.deepEqual(
      copied.filter((table) => !content.includes(table)),
      []
    );
    assert.ok(!rowsText.includes("public.users_id_seq"));
  }
);

test("the copy holds the demo content and no users", { skip: !enabled }, () => {
  const lists = listedTables();
  assert.deepEqual(
    tablesWithRows().filter((table) => !lists.content.includes(table)),
    []
  );

  for (const table of [
    "pages",
    "posts",
    "authors",
    "categories",
    "media",
    "forms",
    "redirects",
  ]) {
    const count = `select count(*) from "${table}"`;
    assert.deepEqual(
      sql(TARGET, TARGET_DB, count),
      sql(SOURCE, "postgres", count),
      table
    );
  }

  assert.ok(
    Number(sql(TARGET, TARGET_DB, "select count(*) from pages")[0]) > 0
  );
  // The link to a user is gone; the page it was on is still there.
  assert.deepEqual(
    sql(
      TARGET,
      TARGET_DB,
      "select count(*) from pages_rels where users_id is not null"
    ),
    ["0"]
  );

  // Indexes, foreign keys and migrations match the source.
  for (const count of [
    "select count(*) from pg_constraint where contype = 'f'",
    "select count(*) from pg_indexes where schemaname = 'public'",
    "select count(*) from payload_migrations",
  ]) {
    assert.deepEqual(
      sql(TARGET, TARGET_DB, count),
      sql(SOURCE, "postgres", count),
      count
    );
  }

  // The next page added locally gets a new id.
  const [nextId] = sql(
    TARGET,
    TARGET_DB,
    "insert into pages (title, updated_at, created_at) values ('added locally', now(), now()) returning id"
  );

  const [maxSource] = sql(SOURCE, "postgres", "select max(id) from pages");
  assert.ok(Number(nextId) > Number(maxSource));
});
