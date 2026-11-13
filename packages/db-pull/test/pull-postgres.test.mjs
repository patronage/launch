// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// oxlint-disable func-style, no-use-before-define -- Helpers are declared beside the tests that use them, as in the suite this was ported from.
/**
 * Run with `node --test test/*.test.mjs` from packages/db-pull (the package's
 * `pnpm test`). Needs bash and Node only: `pscale`, `docker`, server-id.mjs
 * and the app's after-script are replaced by test/fixtures/stub.mjs, so no
 * test contacts PlanetScale, Docker or a database. Each run gets a throwaway
 * kit folder (the script and the stub as server-id.mjs) and app folder (its
 * db-pull.env, db-pull.tables and after-script).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const SCRIPT = path.join(import.meta.dirname, "..", "pull-postgres.sh");
const STUB = path.join(import.meta.dirname, "fixtures", "stub.mjs");

// The password the stub's `pscale role create` answers with.
const STUB_ROLE_PASSWORD = "pscale_pw_stub-secret-never-print-me";
const LOCAL_TARGET_PASSWORD = "local-target-pw";
const LOCAL_TARGET = `postgres://root:${LOCAL_TARGET_PASSWORD}@localhost:5436/launch_payload`;
const PSCALE_ORG = "demo-org";

const STOP_DEV_NOTE =
  "Stop the app's dev or preview server first: this run replaces the database that server has open, and cannot move it aside while the server keeps connecting to it.";

// What every data-handling note says about the copy.
const COPY_NOTE =
  "The copy holds site content only, drafts included. Users, password hashes, API keys, sessions, form submissions and jobs were left out of the dump. Do not seed other environments from it.";

// The test app's db-pull.tables.
const TABLES_FILE = `# Test tables
content pages
content pages_rels
content payload_migrations
content posts # on the list, not in the source: matches nothing
excluded form_submissions   # answers
excluded users
excluded users_sessions
`;

const DELETE_COMMAND = "pnpm db:recreate";

// The stub's source: SOURCE_TABLES in fixtures/stub.mjs. The first three are
// on the content list.
const STUB_CONTENT_TABLES = new Set([
  "pages",
  "pages_rels",
  "payload_migrations",
]);

const STUB_LEFT_OUT_TABLES = ["form_submissions", "users", "users_sessions"];

const REMOVE_USER_LINKS =
  'delete from "pages_rels" where "users_id" is not null';

const DUMP_TABLE = "--table=public.";
const SOURCE_HOST = "stub.pg.psdb.cloud";
const TARGET_DB = "launch_payload";
const SCRATCH_DB = "launch_payload__pull_new";
const OLD_DB = "launch_payload__pull_old";
const DATABASE_DDL = /^(?:create|drop|alter) database /u;

// A mode modulo this is its permission bits.
const FILE_MODE_SPAN = 0o1000;
const ROLE_NAME = /^db-pull-\d{14}-\d+-[0-9a-f]{8}$/u;
const SIGNAL_TEST_TIMEOUT_MS = 30_000;

// Printed when a database other than the one to delete exists: the script
// cannot tell whether an earlier pull filled it.
const EARLIER_PULL_NOTE =
  "A database listed above that an earlier 'pnpm db:pull' filled holds copied data too: delete it the same way.";

const POLL_MS = 50;

const tempRoot = mkdtempSync(path.join(tmpdir(), "db-pull-test-"));

/** The scripts `startScript` started, so none outlives a failed test. */
const started = [];

after(() => {
  // A test that fails between starting a script and signalling it would
  // leave the script waiting in its stub, and the test process waiting on it.
  for (const child of started) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group is already gone.
      }
    }
  }

  rmSync(tempRoot, { force: true, recursive: true });
});

/**
 * Lays out a throwaway kit folder (a copy of the script, and the stub as
 * server-id.mjs) and app folder (db-pull.env, db-pull.tables and the stub as
 * its after-script), with `pscale` and `docker` on PATH.
 *
 * `layout.config` replaces lines of db-pull.env; `layout.tables` replaces
 * db-pull.tables.
 */
function makeSandbox(scenario = {}, layout = {}) {
  const dir = mkdtempSync(path.join(tempRoot, "run-"));
  const binDir = path.join(dir, "bin");
  const kitDir = path.join(dir, "kit");
  const appDir = path.join(dir, "app");
  const workDir = path.join(dir, "tmp");

  for (const made of [binDir, kitDir, path.join(appDir, "scripts"), workDir]) {
    mkdirSync(made, { recursive: true });
  }

  const config = {
    PSCALE_ORG,
    PSCALE_DATABASE: "demo-db",
    PSCALE_BRANCH: "main",
    PG_MAJOR: "17",
    TARGET_URL: LOCAL_TARGET,
    DELETE_COMMAND: undefined,
    AFTER_SCRIPT: "scripts/after.mjs",
    ...layout.config,
  };

  writeFileSync(
    path.join(appDir, "db-pull.env"),
    `# Test settings\n${Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`
  );
  writeFileSync(
    path.join(appDir, "db-pull.tables"),
    layout.tables ?? TABLES_FILE
  );
  copyFileSync(SCRIPT, path.join(kitDir, "pull-postgres.sh"));
  copyFileSync(STUB, path.join(kitDir, "server-id.mjs"));
  copyFileSync(STUB, path.join(appDir, "scripts", "after.mjs"));

  for (const program of ["pscale", "docker"]) {
    const wrapper = path.join(binDir, program);
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${program} "$@"\n`
    );
    chmodSync(wrapper, 0o755);
  }

  // Every `node` the script starts goes through this wrapper, which writes
  // down the arguments: what `ps` would show while it runs.
  const nodeWrapper = path.join(binDir, "node");
  writeFileSync(
    nodeWrapper,
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >>"$STUB_DIR/node-args.txt"\nexec "${process.execPath}" "$@"\n`
  );
  chmodSync(nodeWrapper, 0o755);
  writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
  writeFileSync(path.join(dir, "ca.pem"), "stub CA bundle\n");

  return {
    appDir,
    dir,
    script: path.join(kitDir, "pull-postgres.sh"),
    workDir,
    env: {
      HOME: dir,
      PULL_DB_TARGET_URL: LOCAL_TARGET,
      PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      SSL_CERT_FILE: path.join(dir, "ca.pem"),
      STUB_DIR: dir,
      TMPDIR: workDir,
    },
  };
}

function readCalls(sandbox) {
  const file = path.join(sandbox.dir, "calls.jsonl");

  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readRoles(sandbox) {
  const file = path.join(sandbox.dir, "roles.json");

  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : [];
}

/** The databases the stub's local server holds; untouched means the target. */
function readDatabases(sandbox) {
  const file = path.join(sandbox.dir, "databases.json");

  return existsSync(file)
    ? JSON.parse(readFileSync(file, "utf-8")).toSorted()
    : [TARGET_DB];
}

/** The calls to one Postgres client, e.g. `pg_dump`, run through docker. */
function clientCalls(calls, tool) {
  return calls.filter(
    (call) => call.program === "docker" && call.args.includes(tool)
  );
}

/** Every SQL statement the script ran on the local target, in order. */
function targetStatements(calls) {
  return clientCalls(calls, "psql")
    .filter((call) => call.env.PGHOST !== SOURCE_HOST)
    .flatMap((call) =>
      call.args.filter((_arg, at) => call.args[at - 1] === "--command")
    );
}

/** The statements that create, drop or rename a database, in order. */
function databaseDdl(calls) {
  return targetStatements(calls).filter((sql) => DATABASE_DDL.test(sql));
}

/** The tables whose rows a pg_dump call was told to dump. */
function tablesOfDump(dump) {
  return dump.args
    .filter((arg) => arg.startsWith(DUMP_TABLE))
    .map((arg) => arg.slice(DUMP_TABLE.length));
}

/** The test app's content list, in the order the script names them. */
function contentAllowlist() {
  return TABLES_FILE.split("\n")
    .map((line) => line.replace(/#.*/u, "").trim().split(/\s+/u))
    .filter(([kind]) => kind === "content")
    .map(([, table]) => table)
    .toSorted();
}

/** What `--list-tables` prints, as { content: [...], excluded: [...] }. */
function listedTables() {
  const { result } = runScript({}, { args: ["--list-tables"] });
  assert.equal(result.status, 0, result.stderr);
  const lists = { content: [], excluded: [] };

  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [kind, table, ...rest] = line.split(" ");
    assert.ok(kind in lists && table && rest.length === 0, line);
    lists[kind].push(table);
  }

  return lists;
}

/** The arguments of every `node` the script started, one per line. */
function nodeArguments(sandbox) {
  const file = path.join(sandbox.dir, "node-args.txt");

  return existsSync(file) ? readFileSync(file, "utf-8") : "";
}

/**
 * Where the script keeps its lock for the test target: under the home
 * directory, so runs with different TMPDIR values still meet at one lock.
 */
function lockPath(sandbox) {
  return path.join(
    sandbox.dir,
    ".cache/launch-db-pull/5436-launch_payload.lock"
  );
}

/** The after-script calls, in order. */
function afterCalls(calls) {
  return calls.filter((call) => call.program === "after");
}

/**
 * What must hold after every run, however it ended: the role's password was
 * neither printed nor passed as an argument; the local password was passed
 * as an argument to nothing; the temporary directories and the lock are
 * gone; nothing but content was dumped, and the copy was checked for that
 * before it was swapped in; every Payload command ran against the local target; and
 * `payload migrate` was printed only with the settings that pin it there.
 */
function assertNothingLeaked(sandbox, result) {
  const calls = readCalls(sandbox);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!output.includes(STUB_ROLE_PASSWORD));

  for (const call of calls) {
    assert.ok(!call.args.join(" ").includes(STUB_ROLE_PASSWORD));
    assert.ok(!call.args.join(" ").includes(LOCAL_TARGET_PASSWORD));
  }

  assert.ok(!nodeArguments(sandbox).includes(LOCAL_TARGET_PASSWORD));
  assertOnlyContentCopied(calls);
  assert.deepEqual(readdirSync(sandbox.workDir), []);
  assert.ok(!existsSync(lockPath(sandbox)));
  assert.ok(!existsSync(`${lockPath(sandbox)}.takeover`));

  for (const call of afterCalls(calls)) {
    assert.match(call.env.PULL_DB_TARGET_URL, /@(?:localhost|\[::1\]):/u);
  }
}

/**
 * Fails when a pg_dump call could have read the rows of a table that is not
 * on the content allowlist, or when a run renamed the scratch database into
 * place without first asking, in that database, whether each table outside
 * the allowlist is empty.
 *
 * A pg_dump call is either definitions only (--schema-only) or rows only
 * (--data-only) of exactly the allowlisted tables, whatever production's
 * tables were when the script listed them.
 */
function assertOnlyContentCopied(calls) {
  for (const dump of clientCalls(calls, "pg_dump")) {
    const tables = tablesOfDump(dump);

    if (dump.args.includes("--schema-only")) {
      assert.ok(!dump.args.includes("--data-only"));
      assert.deepEqual(tables, []);
    } else {
      assert.ok(
        dump.args.includes("--data-only"),
        "a dump with rows and definitions"
      );
      assert.deepEqual(tables, contentAllowlist());
      assert.ok(STUB_CONTENT_TABLES.isSubsetOf(new Set(tables)));
      assert.deepEqual(
        STUB_LEFT_OUT_TABLES.filter((table) => tables.includes(table)),
        [],
        "dumped the rows of a table that is not on the content allowlist"
      );
    }
  }

  const swapAt = calls.findIndex((call) =>
    call.args.some((arg) =>
      arg.startsWith(`alter database "${SCRATCH_DB}" rename to`)
    )
  );

  if (swapAt === -1) {
    return;
  }

  const checked = calls
    .slice(0, swapAt)
    .some(
      (call) =>
        call.env.PGDATABASE === SCRATCH_DB &&
        call.args.some((arg) =>
          STUB_LEFT_OUT_TABLES.every((table) =>
            arg.includes(
              `select '${table}' where exists (select 1 from "${table}")`
            )
          )
        )
    );

  assert.ok(checked, "swapped in without checking the left-out tables");
}

/** Runs the script in a sandbox and returns its result and the stub's log. */
function runScript(scenario = {}, { args = [], env = {}, layout = {} } = {}) {
  const sandbox = makeSandbox(scenario, layout);

  const result = spawnSync("bash", [sandbox.script, ...args], {
    cwd: sandbox.appDir,
    encoding: "utf-8",
    env: { ...sandbox.env, ...env },
  });

  assertNothingLeaked(sandbox, result);

  return {
    calls: readCalls(sandbox),
    databases: readDatabases(sandbox),
    result,
    roles: readRoles(sandbox),
    sandbox,
  };
}

test("a dry run prints the plan and contacts nothing", () => {
  const { calls, result } = runScript({}, { args: ["--dry-run"] });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dry run: nothing was contacted or changed/u);
  assert.match(result.stdout, /--inherited-roles pg_read_all_data --ttl 30m/u);
  assert.match(
    result.stdout,
    /postgres:\/\/root:\*\*\*@localhost:5436\/launch_payload/u
  );
  assert.ok(!result.stdout.includes("local-target-pw"));
  assert.deepEqual(calls, []);
});

test("refuses a target that is not on this machine, before contacting anything", () => {
  const targets = [
    "postgres://u:p@aws-us-east-1-4.pg.psdb.cloud:5432/postgres",
    "postgres://u:p@localhost.example.com/launch_payload",
    "postgres://localhost:p@example.com/launch_payload",
    "postgres://u:p@10.0.0.5:5436/launch_payload",
    "postgres://u:p@host.docker.internal:5436/launch_payload",
  ];

  for (const target of targets) {
    for (const args of [[], ["--dry-run"]]) {
      const { calls, result } = runScript(
        {},
        { args, env: { PULL_DB_TARGET_URL: target } }
      );

      assert.equal(result.status, 1, target);
      assert.match(result.stderr, /refusing to restore into host/u, target);
      assert.deepEqual(calls, [], target);
    }
  }
});

test("an IPv6 target keeps its brackets in every address the script prints", () => {
  const sandbox = makeSandbox();

  const env = {
    ...sandbox.env,
    PULL_DB_TARGET_URL:
      "postgres://dev%40home:dev-pw@[::1]:5999/launch_payload",
  };

  const run = (args) =>
    spawnSync("bash", [sandbox.script, ...args], {
      cwd: sandbox.appDir,
      encoding: "utf-8",
      env,
    });

  const plan = run(["--dry-run"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(
    plan.stdout,
    /postgres:\/\/dev%40home:\*\*\*@\[::1\]:5999\/launch_payload/u
  );

  const pulled = run([]);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.ok(
    pulled.stdout.includes(
      "Running scripts/after.mjs against postgres://dev%40home:***@[::1]:5999/launch_payload..."
    ),
    pulled.stdout
  );
  assert.ok(pulled.stdout.includes("on the server at [::1]:5999."));
  assert.ok(!`${pulled.stdout}${pulled.stderr}`.includes("dev-pw"));
});

test("refuses a target URL it cannot use", () => {
  const targets = {
    "mysql://u:p@localhost/db": /not a postgres:\/\/ URL/u,
    "not a url": /not a postgres:\/\/ URL/u,
    "postgres://u:p@localhost/postgres": /cannot be 'postgres'/u,
    'postgres://u:p@localhost/a"b': /must be letters, digits/u,
    "postgres://localhost/db": /names no user/u,
    // node-postgres would connect to the host in the query string.
    "postgres://u:p@localhost:5436/db?host=prod.example&port=5432&user=prod&password=pw":
      /must not have a query string or a fragment/u,
    "postgres://u:p@localhost:5436/db?sslmode=disable":
      /must not have a query string or a fragment/u,
    "postgres://u:p@localhost:5436/db#host=prod.example":
      /must not have a query string or a fragment/u,
  };

  for (const [target, message] of Object.entries(targets)) {
    const { calls, result } = runScript(
      {},
      { env: { PULL_DB_TARGET_URL: target } }
    );

    assert.equal(result.status, 1, target);
    assert.match(result.stderr, message, target);
    assert.deepEqual(calls, [], target);
  }
});

test("rejects an unknown argument", () => {
  const { calls, result } = runScript({}, { args: ["--force"] });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: pnpm db:pull/u);
  assert.deepEqual(calls, []);
});

test("pulls production with a read-only role and deletes the role", () => {
  const { calls, databases, result, roles } = runScript();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(roles, []);
  assert.deepEqual(databases, [TARGET_DB]);

  const pscaleCalls = calls.filter((call) => call.program === "pscale");
  const [, create, remove] = pscaleCalls;
  assert.deepEqual(
    pscaleCalls.map((call) => call.args[1]),
    ["list", "create", "delete"]
  );
  assert.match(create.args[4], ROLE_NAME);
  assert.deepEqual(create.args.slice(5), [
    "--inherited-roles",
    "pg_read_all_data",
    "--ttl",
    "30m",
    "--format",
    "json",
    "--org",
    "demo-org",
  ]);
  assert.deepEqual(remove.args.slice(4), [
    "stubrole1234",
    "--force",
    "--org",
    "demo-org",
  ]);

  // Two dumps: the definitions with no rows, then the rows of the tables on
  // the allowlist.
  const [dump, rowsDump] = clientCalls(calls, "pg_dump");
  assert.equal(clientCalls(calls, "pg_dump").length, 2);
  assert.deepEqual(dump.args.slice(dump.args.indexOf("pg_dump")), [
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--schema=public",
    "--schema-only",
  ]);
  assert.deepEqual(rowsDump.args.slice(rowsDump.args.indexOf("pg_dump")), [
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--data-only",
    ...contentAllowlist().map((table) => `--table=public.${table}`),
  ]);
  assert.deepEqual(rowsDump.env, dump.env);
  assert.deepEqual(dump.env, {
    PGAPPNAME: "db-pull",
    PGCONNECT_TIMEOUT: "15",
    PGDATABASE: "postgres",
    PGHOST: SOURCE_HOST,
    PGOPTIONS: "-c default_transaction_read_only=on",
    PGPASSWORD: STUB_ROLE_PASSWORD,
    // The direct port, not PgBouncer on 6432.
    PGPORT: "5432",
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "/db-pull-tls/ca.pem",
    PGUSER: "pscale_api_stubrole1234.branch",
    // The docker command's own environment, not the container's: only the
    // PG* names above are passed in with -e.
    PULL_DB_TARGET_URL: LOCAL_TARGET,
  });

  // The role is gone before anything is restored.
  const order = calls.map((call) =>
    call.program === "pscale"
      ? call.args[1]
      : call.args.find((arg) => arg === "pg_dump" || arg === "pg_restore")
  );

  assert.ok(order.lastIndexOf("pg_dump") < order.indexOf("delete"));
  assert.ok(order.indexOf("delete") < order.indexOf("pg_restore"));

  // Tables, then rows, then the indexes and foreign keys.
  const restoreSteps = clientCalls(calls, "pg_restore").map((call) =>
    call.args.slice(call.args.indexOf("pg_restore") + 1)
  );

  const common = ["--no-owner", "--no-privileges", "--exit-on-error"];
  const into = "--dbname=launch_payload__pull_new";
  assert.deepEqual(restoreSteps, [
    [...common, "--section=pre-data", into],
    [...common, "--data-only", into],
    [...common, "--section=post-data", into],
  ]);
  const [restore] = clientCalls(calls, "pg_restore");
  assert.equal(restore.env.PGHOST, "host.docker.internal");
  assert.equal(restore.env.PGPORT, "5436");
  assert.equal(restore.env.PGPASSWORD, "local-target-pw");

  // The target is moved aside, never dropped, before the copy is in place.
  assert.deepEqual(databaseDdl(calls), [
    `drop database if exists "${SCRATCH_DB}" with (force)`,
    `create database "${SCRATCH_DB}"`,
    `drop database if exists "${OLD_DB}" with (force)`,
    `alter database "${TARGET_DB}" rename to "${OLD_DB}"`,
    `alter database "${SCRATCH_DB}" rename to "${TARGET_DB}"`,
    `drop database if exists "${OLD_DB}" with (force)`,
  ]);

  // The dump recreates `public`, so the scratch database must not have one.
  const dropSchema = clientCalls(calls, "psql").find((call) =>
    call.args.includes("drop schema public")
  );

  assert.equal(dropSchema.env.PGDATABASE, "launch_payload__pull_new");

  assert.match(result.stdout, /Leaving the rows of 3 tables in PlanetScale\./u);
  // The after-script ran once, after the swap, with the target and no
  // --migrate.
  const [afterScript] = afterCalls(calls);
  assert.equal(afterCalls(calls).length, 1);
  assert.equal(afterScript.env.PULL_DB_TARGET_URL, LOCAL_TARGET);
  assert.equal(afterScript.env.PULL_DB_MIGRATE, "0");
  assert.ok(
    calls.indexOf(afterScript) >
      calls.findIndex((call) =>
        call.args.includes(
          `alter database "${SCRATCH_DB}" rename to "${TARGET_DB}"`
        )
      )
  );
  assert.match(result.stdout, /stub after-script ran/u);
});

test("no client that touches the local target can reach PlanetScale, and none that reads PlanetScale can write", () => {
  const { calls } = runScript();

  for (const call of calls.filter((entry) => entry.program === "docker")) {
    if (call.args[0] === "info" || call.args[0] === "context") {
      continue;
    }

    if (call.env.PGHOST === SOURCE_HOST) {
      assert.equal(
        call.env.PGOPTIONS,
        "-c default_transaction_read_only=on",
        call.args.join(" ")
      );
      assert.ok(!call.args.includes("pg_restore"));
    } else {
      assert.equal(call.env.PGHOST, "host.docker.internal");
      assert.notEqual(call.env.PGPASSWORD, STUB_ROLE_PASSWORD);
    }
  }
});

test("refuses a docker command that does not talk to a local unix socket", () => {
  const endpoints = [
    "tcp://10.0.0.5:2376",
    "ssh://deploy@build.example.com",
    "npipe:////./pipe/docker_engine",
  ];

  for (const dockerEndpoint of endpoints) {
    const { calls, result } = runScript({ dockerEndpoint });

    assert.equal(result.status, 1, dockerEndpoint);
    assert.match(
      result.stderr,
      /refusing to run: the docker command talks to/u
    );
    assert.ok(result.stderr.includes(dockerEndpoint));
    // Nothing but the question itself reached docker, and nothing pscale.
    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 2).join(" ")),
      ["context inspect"]
    );
  }

  const unknown = runScript({ dockerContextFails: true });
  assert.equal(unknown.result.status, 1);
  assert.match(unknown.result.stderr, /cannot tell which Docker daemon/u);
  assert.equal(unknown.calls.length, 1);
});

test("every docker command after the check uses the socket that was checked", () => {
  // Another terminal can run `docker context use <remote>` during the run.
  const dockerEndpoint = "unix:///Users/someone/.orbstack/run/docker.sock";

  const { calls, result } = runScript(
    { dockerEndpoint },
    { env: { DOCKER_CONTEXT: "orbstack" } }
  );

  const docker = calls.filter((call) => call.program === "docker");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(docker[0].args.slice(0, 2), ["context", "inspect"]);
  assert.ok(docker.length > 5);

  for (const call of docker.slice(1)) {
    assert.deepEqual(
      call.daemon,
      { host: dockerEndpoint },
      call.args.join(" ")
    );
  }
});

test("refuses when Docker and this machine reach different servers at the target address", () => {
  // host.docker.internal is the host's gateway address, not its loopback.
  const other = runScript({
    dockerServerId: "7399999999999999999 1794400555.5",
  });

  assert.equal(other.result.status, 1);
  assert.match(
    other.result.stderr,
    /Docker reaches a different Postgres server at host\.docker\.internal:5436 than this machine reaches at localhost:5436/u
  );

  const unreachable = runScript({ failServerId: true });
  assert.equal(unreachable.result.status, 1);
  assert.match(
    unreachable.result.stderr,
    /could not reach .* from this machine/u
  );

  for (const { calls, databases } of [other, unreachable]) {
    assert.deepEqual(
      calls.filter((call) => call.program === "pscale"),
      []
    );
    assert.deepEqual(databases, [TARGET_DB]);
  }

  // The question went to the target the Payload steps use, and nowhere else.
  const asked = other.calls.find((call) => call.program === "server-id");
  assert.equal(asked.env.PULL_DB_SERVER_URL, LOCAL_TARGET);
});

test("works with a pscale that has no `role list --name`, and leaves other roles alone", () => {
  const payloadRole = { id: "longlived1", name: "payload" };

  const { calls, result, roles } = runScript({
    existingRoles: [payloadRole],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(roles, [payloadRole]);
  assert.ok(!result.stderr.includes("already has db-pull roles"));

  for (const call of calls.filter((entry) => entry.program === "pscale")) {
    assert.ok(!call.args.includes("--name"), call.args.join(" "));
  }
});

test("refuses while another run holds the lock, and takes over a dead run's lock", () => {
  const busy = makeSandbox();
  const lock = lockPath(busy);
  mkdirSync(lock, { recursive: true });
  // This test process is alive, so the lock is held.
  writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);

  const refused = spawnSync("bash", [busy.script], {
    cwd: busy.appDir,
    encoding: "utf-8",
    env: busy.env,
  });

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /another 'pnpm db:pull' \(process \d+\)/u);
  assert.deepEqual(
    readCalls(busy).filter((call) => call.program === "pscale"),
    []
  );
  // The other run's lock is not this run's to remove.
  assert.ok(existsSync(path.join(lock, "pid")));

  const stale = makeSandbox();
  const staleLock = lockPath(stale);
  mkdirSync(staleLock, { recursive: true });
  const gone = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(path.join(staleLock, "pid"), `${gone.pid}\n`);

  const result = spawnSync("bash", [stale.script], {
    cwd: stale.appDir,
    encoding: "utf-8",
    env: stale.env,
  });

  assert.equal(result.status, 0, result.stderr);
  assertNothingLeaked(stale, result);
});

test("runs with different TMPDIR values meet at the same lock", () => {
  const sandbox = makeSandbox();
  const lock = lockPath(sandbox);
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
  const elsewhere = path.join(sandbox.dir, "another-tmp");
  mkdirSync(elsewhere);

  const result = spawnSync("bash", [sandbox.script], {
    cwd: sandbox.appDir,
    encoding: "utf-8",
    env: { ...sandbox.env, TMPDIR: elsewhere },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /another 'pnpm db:pull' \(process \d+\)/u);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("two runs in the same second with the same process id would not share a role name", () => {
  // The name carries random characters: time and process id repeat across
  // machines, and a run finds and deletes its role by this name.
  const names = [runScript(), runScript()].map(({ calls }) =>
    calls
      .find((call) => call.program === "pscale" && call.args.includes("create"))
      .args.find((arg) => arg.startsWith("db-pull-"))
  );

  for (const name of names) {
    assert.match(name, ROLE_NAME);
  }

  assert.notEqual(names[0].split("-").at(-1), names[1].split("-").at(-1));
});

/** Leaves the lock of a run that has ended in the sandbox, and returns its path. */
function leaveDeadLock(sandbox) {
  const lock = lockPath(sandbox);
  mkdirSync(lock, { recursive: true });
  const gone = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(path.join(lock, "pid"), `${gone.pid}\n`);

  return lock;
}

test("does not remove a dead run's lock while another run is taking it over", () => {
  const sandbox = makeSandbox();
  const lock = leaveDeadLock(sandbox);
  const before = readFileSync(path.join(lock, "pid"), "utf-8");
  mkdirSync(`${lock}.takeover`);

  const result = spawnSync("bash", [sandbox.script], {
    cwd: sandbox.appDir,
    encoding: "utf-8",
    env: sandbox.env,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is taking over the lock a dead run left/u);
  assert.equal(readFileSync(path.join(lock, "pid"), "utf-8"), before);
  // The other run's takeover directory is not this run's to remove.
  assert.ok(existsSync(`${lock}.takeover`));
  assert.deepEqual(
    readCalls(sandbox).filter((call) => call.program === "pscale"),
    []
  );
});

test(
  "of several runs that find the same dead lock at once, exactly one goes on",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    const sandbox = makeSandbox({ hangDump: true });
    const lock = leaveDeadLock(sandbox);
    const runs = Array.from({ length: 8 }, () => startScript(sandbox));

    // The winner waits in its dump; every other run must have stopped.
    await untilCalls(sandbox, dumpStarted);

    const stopped = await Promise.all(
      runs.map((run) =>
        Promise.race([
          run.exited.then(([code]) => code),
          sleep(2000, "running"),
        ])
      )
    );

    const winners = runs.filter((_run, index) => stopped[index] === "running");

    for (const run of winners) {
      process.kill(-run.child.pid, "SIGINT");
    }

    await Promise.all(winners.map((run) => run.exited));

    assert.equal(winners.length, 1, runs.map((run) => run.output).join("\n"));
    assert.deepEqual(
      stopped.filter((code) => code !== "running"),
      Array.from({ length: 7 }, () => 1)
    );
    assert.equal(
      readCalls(sandbox).filter(
        (call) => call.program === "pscale" && call.args.includes("create")
      ).length,
      1
    );
    assert.ok(!existsSync(lock));
    assert.ok(!existsSync(`${lock}.takeover`));
  }
);

test("refuses a local Postgres 16 before creating a role", () => {
  const { calls, result } = runScript({ targetMajor: 16 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /local server runs Postgres 16/u);
  assert.match(result.stderr, /postgres:17/u);
  assert.deepEqual(
    calls.filter((call) => call.program === "pscale"),
    []
  );
});

test("stops before the role when Docker is down or pscale cannot list roles", () => {
  const dockerDown = runScript({ dockerDown: true });
  assert.equal(dockerDown.result.status, 1);
  assert.match(dockerDown.result.stderr, /Docker is not running/u);
  assert.deepEqual(
    dockerDown.calls.filter((call) => call.program === "pscale"),
    []
  );

  const loggedOut = runScript({ failList: true });
  assert.equal(loggedOut.result.status, 1);
  assert.match(loggedOut.result.stderr, /pscale auth login/u);
  assert.ok(!loggedOut.calls.some((call) => call.args[1] === "create"));
});

test("a failed dump deletes the role and leaves the local database alone", () => {
  const { calls, result, roles } = runScript({ failDump: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /pg_dump failed/u);
  assert.deepEqual(roles, []);
  assert.deepEqual(clientCalls(calls, "pg_restore"), []);
  assert.deepEqual(databaseDdl(calls), []);
});

test("a failed restore drops the scratch database and leaves the local database alone", () => {
  const { calls, databases, result, roles } = runScript({ failRestore: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /pg_restore failed/u);
  assert.deepEqual(roles, []);
  assert.deepEqual(databases, [TARGET_DB]);
  assert.deepEqual(databaseDdl(calls), [
    `drop database if exists "${SCRATCH_DB}" with (force)`,
    `create database "${SCRATCH_DB}"`,
    `drop database if exists "${SCRATCH_DB}" with (force)`,
  ]);
  assert.match(
    result.stdout,
    /"launch_payload" is your local database, unchanged\./u
  );
  assert.deepEqual(afterCalls(calls), []);
});

test("a restore with fewer tables than production is not swapped in", () => {
  const { calls, databases, result } = runScript({ restoredTables: 146 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /restored 146 tables, but the source has 147/u);
  assert.deepEqual(databases, [TARGET_DB]);
  assert.deepEqual(databaseDdl(calls), [
    `drop database if exists "${SCRATCH_DB}" with (force)`,
    `create database "${SCRATCH_DB}"`,
    `drop database if exists "${SCRATCH_DB}" with (force)`,
  ]);
});

test("the rows of every table that is not on the content allowlist stay in production", () => {
  const { calls, result } = runScript();
  const [, rowsDump] = clientCalls(calls, "pg_dump");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(tablesOfDump(rowsDump), contentAllowlist());

  for (const table of [...STUB_LEFT_OUT_TABLES, "donation_receipts"]) {
    assert.ok(!tablesOfDump(rowsDump).includes(table), table);
  }

  assert.match(result.stdout, /Leaving the rows of 3 tables in PlanetScale\./u);
  // Every table the stub's production has is classified.
  assert.ok(!result.stderr.includes("does not classify"));
});

test("the tables pg_dump may read come from the allowlist, not from what production holds", () => {
  // A table created in production after the script listed its tables is in
  // no list the script made. The dump of rows must not depend on that list.
  const [, usual] = clientCalls(runScript().calls, "pg_dump");

  const [, other] = clientCalls(
    runScript({
      sourceTables: [
        "created_a_second_ago",
        "form_submissions",
        "pages",
        "users",
        "users_sessions",
      ],
    }).calls,
    "pg_dump"
  );

  assert.deepEqual(tablesOfDump(other), tablesOfDump(usual));
  assert.deepEqual(tablesOfDump(other), contentAllowlist());
});

test("a dump of rows that fails deletes the role and leaves the local database alone", () => {
  const { calls, databases, result, roles } = runScript({ failRowsDump: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /pg_dump failed/u);
  assert.deepEqual(roles, []);
  assert.deepEqual(databases, [TARGET_DB]);
  assert.deepEqual(clientCalls(calls, "pg_restore"), []);
});

test("a table the script does not know is left out, and the run says so", () => {
  const { calls, result } = runScript({
    sourceTables: [
      "brand_new_signups",
      "form_submissions",
      "pages",
      "pages_rels",
      "payload_migrations",
      "users",
      "users_sessions",
    ],
  });

  const [, rowsDump] = clientCalls(calls, "pg_dump");

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!tablesOfDump(rowsDump).includes("brand_new_signups"));
  assert.match(
    result.stderr,
    /the source has tables this script does not classify\. Their rows are not copied:\n {2}brand_new_signups\n/u
  );
  assert.match(
    result.stderr,
    /Add each to db-pull\.tables as content or excluded\./u
  );
  // The check before the swap asks about it too.
  assert.ok(
    targetStatements(calls).some((sql) =>
      sql.includes(
        `select 'brand_new_signups' where exists (select 1 from "brand_new_signups")`
      )
    )
  );
});

test("--list-tables prints two lists that share no table, and contacts nothing", () => {
  const { calls, result } = runScript({}, { args: ["--list-tables"] });
  const { content, excluded } = listedTables();

  assert.deepEqual(calls, []);
  assert.equal(result.status, 0);
  assert.ok(content.length > 0 && excluded.length > 0);
  assert.deepEqual(
    content.filter((table) => excluded.includes(table)),
    []
  );
  assert.equal(
    new Set([...content, ...excluded]).size,
    content.length + excluded.length
  );

  // What must never be on the allowlist, whatever else changes.
  for (const table of ["users", "users_sessions", "form_submissions"]) {
    assert.ok(excluded.includes(table), table);
    assert.ok(!content.includes(table), table);
  }

  assert.ok(content.includes("payload_migrations"));
});

test("removes the links to rows that were not copied, between the rows and the foreign keys", () => {
  const { calls, result } = runScript({
    sourceLinks: ["pages_rels users_id c 1 0", "pages editor_id n 1 4"],
  });

  assert.equal(result.status, 0, result.stderr);

  const linksAt = calls.findIndex((call) =>
    call.args.includes(REMOVE_USER_LINKS)
  );

  const links = calls[linksAt];
  assert.equal(links.env.PGDATABASE, SCRATCH_DB);
  assert.equal(links.env.PGHOST, "host.docker.internal");
  assert.ok(links.args.includes("--single-transaction"));
  assert.deepEqual(
    links.args.filter((_arg, at) => links.args[at - 1] === "--command"),
    [
      // ON DELETE CASCADE: the link row goes.
      REMOVE_USER_LINKS,
      // ON DELETE SET NULL: the column is emptied and the row stays.
      'update "pages" set "editor_id" = null where "editor_id" is not null',
    ]
  );

  const restores = calls
    .map((call, at) => (call.args.includes("pg_restore") ? at : -1))
    .filter((at) => at !== -1);

  // After the rows, before the indexes and foreign keys.
  assert.equal(restores.length, 3);
  assert.ok(restores[1] < linksAt && linksAt < restores[2]);
});

test("stops before the dump when a link to a left-out table could not be removed", () => {
  const cases = [
    // ON DELETE NO ACTION.
    [
      ["pages_rels users_id a 1 0"],
      /pages_rels\.users_id points at a left-out table and is not ON DELETE CASCADE or SET NULL/u,
    ],
    // ON DELETE RESTRICT.
    [["pages_rels users_id r 1 0"], /is not ON DELETE CASCADE or SET NULL/u],
    // Deleting the rows would orphan the rows of tables that point at them.
    [["pages author_id c 1 3"], /other tables point at pages/u],
    [["pages_rels users_id c 2 0"], /a foreign key of 2 columns/u],
    [['pages_rels users"id c 1 0'], /cannot name safely/u],
  ];

  for (const [sourceLinks, message] of cases) {
    const { calls, databases, result, roles } = runScript({ sourceLinks });

    assert.equal(result.status, 1, sourceLinks[0]);
    assert.match(result.stderr, message);
    assert.deepEqual(clientCalls(calls, "pg_dump"), []);
    assert.deepEqual(roles, []);
    assert.deepEqual(databases, [TARGET_DB]);
  }
});

test("refuses a table name it cannot pass on safely", () => {
  const { calls, result, roles } = runScript({
    sourceTables: ["pages", 'users" --'],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot name safely/u);
  assert.deepEqual(clientCalls(calls, "pg_dump"), []);
  assert.deepEqual(roles, []);
});

test("a copy that holds rows in a left-out table is not swapped in", () => {
  const { calls, databases, result } = runScript({
    rowsLeftIn: ["users", "form_submissions"],
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /the copy holds rows in tables that must be empty: form_submissions users ?\. The local database is unchanged\./u
  );
  assert.deepEqual(databases, [TARGET_DB]);
  assert.deepEqual(databaseDdl(calls), [
    `drop database if exists "${SCRATCH_DB}" with (force)`,
    `create database "${SCRATCH_DB}"`,
    `drop database if exists "${SCRATCH_DB}" with (force)`,
  ]);
  assert.match(
    result.stdout,
    /"launch_payload" is your local database, unchanged\./u
  );
  assert.deepEqual(afterCalls(calls), []);
});

test("a table the copy has and production did not list is checked too", () => {
  // The check reads the copy's own tables, not the list the dump was made with.
  const { databases, result } = runScript({
    rowsLeftIn: ["surprise_table"],
    restoredTableNames: [
      "form_submissions",
      "pages",
      "pages_rels",
      "payload_migrations",
      "surprise_table",
      "users",
      "users_sessions",
    ],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be empty: surprise_table/u);
  assert.deepEqual(databases, [TARGET_DB]);
});

test("a check of the left-out tables that fails is not taken for a clean copy", () => {
  for (const failSql of [
    ["where exists (select 1 from"],
    [REMOVE_USER_LINKS],
  ]) {
    const { calls, databases, result } = runScript({ failSql });

    assert.equal(result.status, 1, failSql[0]);
    assert.match(result.stderr, /The local database is unchanged\./u);
    assert.deepEqual(databases, [TARGET_DB]);
    assert.deepEqual(afterCalls(calls), []);
  }
});

test("indexes and foreign keys that cannot be added leave the local database alone", () => {
  const { calls, databases, result } = runScript({ failPostData: true });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /pg_restore could not add the indexes and foreign keys\. The local database is unchanged\./u
  );
  assert.deepEqual(databases, [TARGET_DB]);
  assert.deepEqual(afterCalls(calls), []);
});

test("says to stop pnpm dev before it contacts anything, and in the plan and the help", () => {
  const { result } = runScript();
  const plan = runScript({}, { args: ["--dry-run"] }).result;
  const help = runScript({}, { args: ["--help"] }).result;

  assert.equal(result.stdout.split("\n")[0], STOP_DEV_NOTE);
  assert.ok(plan.stdout.includes(STOP_DEV_NOTE), plan.stdout);
  assert.match(help.stdout, /Stop the dev or preview server first/u);
  // The plan and the help say what stays in production.
  assert.match(
    plan.stdout,
    /--data-only --table=public\.<each allowlisted table>/u
  );
  assert.ok(plan.stdout.includes(COPY_NOTE), plan.stdout);
  assert.match(help.stdout, /The copy holds site content only\./u);

  for (const text of [result, plan, help]) {
    assert.ok(!text.stdout.includes("including password hashes"));
    assert.ok(!text.stdout.includes("supporter and user data"));
  }
});

test("the target URL, with the local password, is an argument to no node process", () => {
  const { result, sandbox } = runScript();
  const seen = nodeArguments(sandbox);

  assert.equal(result.status, 0, result.stderr);
  // The wrapper saw the script's node calls, the URL parser among them.
  assert.match(seen, /new URL\(process\.env\.PULL_DB_PARSE_URL/u);
  assert.match(seen, /kit\/server-id\.mjs/u);
  assert.ok(!seen.includes(LOCAL_TARGET_PASSWORD));
  assert.ok(!seen.includes("postgres://"));
});

test("a first pull, with no local database yet, puts the copy in place", () => {
  const { calls, databases, result } = runScript({ databases: [] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(databases, [TARGET_DB]);
  assert.ok(
    !databaseDdl(calls).some((sql) => sql.includes(`rename to "${OLD_DB}"`))
  );
});

test("a database left aside by an earlier run does not block the swap", () => {
  const { databases, result } = runScript({ databases: [TARGET_DB, OLD_DB] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(databases, [TARGET_DB]);
});

test("a database a run left between the two renames is kept until the copy is in place", () => {
  // Only the old database exists: it is the developer's data, not a leftover.
  const failed = runScript({
    databases: [OLD_DB],
    failSql: [`alter database "${SCRATCH_DB}" rename to`],
  });

  assert.equal(failed.result.status, 1);
  assert.deepEqual(failed.databases, [OLD_DB, SCRATCH_DB].toSorted());
  assert.match(
    failed.result.stdout,
    /"launch_payload" does not exist\.\n {2}"launch_payload__pull_new" holds copied data that was not swapped in\.\n {2}"launch_payload__pull_old" is your previous local database\./u
  );

  const finished = runScript({ databases: [OLD_DB] });
  assert.equal(finished.result.status, 0, finished.result.stderr);
  assert.deepEqual(finished.databases, [TARGET_DB]);
});

test("when the copy cannot be renamed into place, the local database is put back", () => {
  const { calls, databases, result } = runScript({
    failSql: [`alter database "${SCRATCH_DB}" rename to`],
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /could not move the restored database into place/u
  );
  assert.deepEqual(databases, [TARGET_DB, SCRATCH_DB]);
  assert.match(
    result.stdout,
    /"launch_payload" is your local database, unchanged\.\n {2}"launch_payload__pull_new" holds copied data that was not swapped in\./u
  );
  assert.match(
    result.stdout,
    /To delete the copied data, drop the database "launch_payload__pull_new" on the server at localhost:5436\./u
  );
  // The local database was put back: the advice must not say to drop it.
  assert.doesNotMatch(result.stdout, /drop the databases? "launch_payload"/u);
  // It may be an earlier pull's copy, though, and the script cannot tell.
  assert.ok(result.stdout.includes(EARLIER_PULL_NOTE));
  assert.deepEqual(afterCalls(calls), []);
});

test("a target named in PULL_DB_TARGET_URL is told which databases to drop, not just db:recreate", () => {
  // DELETE_COMMAND removes the app's own local server's data. Told to run it
  // for another target, a developer would leave the copy behind. The port
  // does not say which server it is: another one can listen on 5436.
  const recreate = /run: pnpm db:recreate/u;

  const targets = {
    "postgres://dev:dev-pw@localhost:5436/scratch-copy": "localhost:5436",
    "postgres://dev:dev-pw@localhost:5999/scratch-copy": "localhost:5999",
  };

  for (const [target, server] of Object.entries(targets)) {
    const env = { PULL_DB_TARGET_URL: target };
    const scenario = { databases: ["scratch-copy"] };
    const layout = { config: { DELETE_COMMAND } };

    const runs = [
      runScript(scenario, { env, layout }),
      runScript(scenario, { args: ["--dry-run"], env, layout }),
      runScript(
        { ...scenario, failSql: ['rename to "scratch-copy__pull_old"'] },
        { env, layout }
      ),
    ];

    assert.deepEqual(
      runs.map(({ result }) => result.status),
      [0, 0, 1],
      target
    );

    // Only a database that holds production data is named: the copy once it
    // is in place, the scratch database when the swap failed.
    const holders = ["scratch-copy", "scratch-copy", "scratch-copy__pull_new"];

    for (const [at, { result }] of runs.entries()) {
      assert.ok(
        result.stdout.includes(
          `To delete the copied data, drop the database "${holders[at]}" on the server at ${server}.`
        ),
        result.stdout
      );
      assert.equal(result.stdout.match(/drop the database/gu).length, 1);
      assert.doesNotMatch(result.stdout + result.stderr, recreate);
    }
  }
});

test("when the local database cannot be moved aside, nothing is lost and the copy is dropped", () => {
  const { databases, result } = runScript({
    failSql: [`alter database "${TARGET_DB}" rename to`],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not move "launch_payload" aside/u);
  assert.deepEqual(databases, [TARGET_DB, SCRATCH_DB]);
  assert.match(result.stdout, /holds copied data that was not swapped in/u);
});

test("an old database that cannot be dropped after the swap is reported and fails the run", () => {
  const { calls, databases, result } = runScript({
    failDropOldAfterSwap: true,
  });

  assert.equal(result.status, 1);
  assert.deepEqual(databases, [TARGET_DB, OLD_DB]);
  assert.match(
    result.stderr,
    /previous local database could not be dropped\. It is in "launch_payload__pull_old"\. If an earlier 'pnpm db:pull' filled it, it holds copied data too: drop it yourself, or run 'pnpm db:pull' again, which drops it first\./u
  );
  // The copy is in place, so the rest of the run still happens.
  assert.deepEqual(afterCalls(calls).length, 1);
});

test("a role that could write is deleted without a dump", () => {
  const { calls, result, roles } = runScript({ roleCanWrite: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not read-only/u);
  assert.deepEqual(roles, []);
  assert.deepEqual(clientCalls(calls, "pg_dump"), []);
});

test("a production server on another Postgres version is not dumped", () => {
  const { calls, result, roles } = runScript({ sourceMajor: 18 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /the source runs Postgres 18/u);
  assert.deepEqual(roles, []);
  assert.deepEqual(clientCalls(calls, "pg_dump"), []);
});

test("a role whose id pscale never reported is found by name and deleted", () => {
  const { calls, result, roles } = runScript({ createAnswersNothing: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not create the role/u);
  assert.deepEqual(roles, []);
  assert.equal(calls.at(-1).args[1], "delete");
  assert.equal(calls.at(-1).args[4], "stubrole1234");
});

test("a role that was never created needs no delete", () => {
  const { calls, result } = runScript({ failCreate: true });

  assert.equal(result.status, 1);
  assert.ok(!calls.some((call) => call.args[1] === "delete"));
  assert.ok(!result.stderr.includes("could not check"));
});

test("a role that cannot be deleted fails the run and says how to delete it", () => {
  const { calls, result, roles } = runScript({ failDelete: true });

  assert.equal(result.status, 1);
  assert.equal(roles.length, 1);
  assert.match(
    result.stderr,
    /pscale role delete demo-db main stubrole1234 --org demo-org --force/u
  );
  // The dump is not restored while its role may still exist.
  assert.deepEqual(clientCalls(calls, "pg_restore"), []);
});

test("warns about roles an earlier run left behind", () => {
  const { result } = runScript({
    existingRoles: [{ id: "old1", name: "db-pull-20260101000000-1" }],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /db-pull-20260101000000-1 \(old1\)/u);
});

/**
 * Resolves once `found(calls)` is true of the stub's log. Gives up after the
 * signal tests' time limit, so a script that stops early fails the test and
 * does not leave the test process polling for ever.
 */
async function untilCalls(
  sandbox,
  found,
  deadline = Date.now() + SIGNAL_TEST_TIMEOUT_MS
) {
  if (found(readCalls(sandbox))) {
    return;
  }

  assert.ok(Date.now() < deadline, "the script never reached the awaited call");
  await sleep(POLL_MS);
  await untilCalls(sandbox, found, deadline);
}

/**
 * Starts the script in its own process group, so a signal sent to the group
 * reaches the script and the program it is waiting on, as Ctrl-C in a
 * terminal does.
 */
function startScript(sandbox) {
  const child = spawn("bash", [sandbox.script], {
    cwd: sandbox.appDir,
    detached: true,
    env: sandbox.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  started.push(child);
  const run = { child, exited: once(child, "exit"), output: "" };
  child.stdout.on("data", (chunk) => (run.output += chunk));
  child.stderr.on("data", (chunk) => (run.output += chunk));

  return run;
}

const dumpStarted = (calls) => clientCalls(calls, "pg_dump").length > 0;

test(
  "Ctrl-C during the dump deletes the role and removes the dump",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    const sandbox = makeSandbox({ hangDump: true });
    const run = startScript(sandbox);

    await untilCalls(sandbox, dumpStarted);
    process.kill(-run.child.pid, "SIGINT");
    const [code] = await run.exited;

    assert.equal(code, 130);
    assert.deepEqual(readRoles(sandbox), []);
    // Said on the terminal, not into the dump file the signal interrupted.
    assert.match(run.output, /Deleted PlanetScale role db-pull-/u);
    assertNothingLeaked(sandbox, { stdout: run.output, stderr: "" });
    assert.deepEqual(clientCalls(readCalls(sandbox), "pg_restore"), []);
  }
);

test(
  "while the dump runs, only this user can enter the directory that holds it, and the CA sits apart",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    const sandbox = makeSandbox({ hangDump: true });
    const run = startScript(sandbox);

    await untilCalls(sandbox, dumpStarted);
    const entries = readdirSync(sandbox.workDir).toSorted();

    const modes = Object.fromEntries(
      entries.map((entry) => [
        entry.replace(/\.[A-Za-z0-9]{6}$/u, ""),
        statSync(path.join(sandbox.workDir, entry)).mode % FILE_MODE_SPAN,
      ])
    );

    const dumpDir = entries.find((entry) => entry.startsWith("db-pull."));
    const caDir = entries.find((entry) => entry.startsWith("db-pull-ca."));
    const [dump] = clientCalls(readCalls(sandbox), "pg_dump");
    const lockMode = statSync(lockPath(sandbox)).mode % FILE_MODE_SPAN;
    process.kill(-run.child.pid, "SIGINT");
    await run.exited;

    assert.deepEqual(modes, {
      "db-pull": 0o700,
      "db-pull-ca": 0o755,
    });
    assert.equal(lockMode, 0o700);
    assert.ok(dumpDir && caDir);
    // The container sees the CA directory and nothing of the dump's.
    assert.deepEqual(
      dump.args.filter((_arg, at) => dump.args[at - 1] === "-v"),
      [`${path.join(sandbox.workDir, caDir)}:/db-pull-tls:ro`]
    );
  }
);

test(
  "a second Ctrl-C while the role is being deleted does not stop the deletion",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    // The first delete fails, so the script waits before it tries again.
    const sandbox = makeSandbox({ failDeleteTimes: 1, hangDump: true });
    const run = startScript(sandbox);

    await untilCalls(sandbox, dumpStarted);
    process.kill(-run.child.pid, "SIGINT");
    await untilCalls(sandbox, (calls) =>
      calls.some((call) => call.args[1] === "delete")
    );
    process.kill(-run.child.pid, "SIGINT");
    process.kill(-run.child.pid, "SIGTERM");
    const [code] = await run.exited;

    assert.equal(code, 130);
    assert.deepEqual(readRoles(sandbox), []);
    assertNothingLeaked(sandbox, { stdout: run.output, stderr: "" });
  }
);

test(
  "Ctrl-C during the restore drops the unfinished copy and says the local database is unchanged",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    const sandbox = makeSandbox({ hangRestore: true });
    const run = startScript(sandbox);

    await untilCalls(
      sandbox,
      (calls) => clientCalls(calls, "pg_restore").length > 0
    );
    process.kill(-run.child.pid, "SIGINT");
    const [code] = await run.exited;

    assert.equal(code, 130);
    assert.deepEqual(readDatabases(sandbox), [TARGET_DB]);
    assert.match(
      run.output,
      /Where the local data is now:\n {2}"launch_payload" is your local database, unchanged\.\n/u
    );
    assertNothingLeaked(sandbox, { stdout: run.output, stderr: "" });
  }
);

test(
  "Ctrl-C after the swap still says the target is a production copy and how to delete it",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    // The first step after the swap: the after-script, which hangs.
    const sandbox = makeSandbox({ hangAfter: true });
    const run = startScript(sandbox);

    await untilCalls(sandbox, (calls) => afterCalls(calls).length > 0);
    process.kill(-run.child.pid, "SIGINT");
    const [code] = await run.exited;

    assert.equal(code, 130);
    assert.deepEqual(readDatabases(sandbox), [TARGET_DB]);
    assert.ok(
      run.output.includes(
        [
          "Where the local data is now:",
          '  "launch_payload" is the copy of the source.',
          "The run stopped before it finished, so the app's after-script (its local admin, for one) did not run. Run 'pnpm db:pull' again.",
          `${COPY_NOTE} To delete the copied data, drop the database "launch_payload" on the server at localhost:5436.`,
        ].join("\n")
      ),
      run.output
    );
    // Nothing else exists, so there is no other database to mention.
    assert.ok(!run.output.includes(EARLIER_PULL_NOTE));
    assertNothingLeaked(sandbox, { stdout: run.output, stderr: "" });
  }
);

test(
  "Ctrl-C while the old database is being dropped says the target is a production copy",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    const sandbox = makeSandbox({ hangDropOldAfterSwap: true });
    const run = startScript(sandbox);
    const renamedIn = `alter database "${SCRATCH_DB}" rename to`;
    const dropOld = `drop database if exists "${OLD_DB}"`;

    // The drop before the swap finds nothing; the one after it hangs.
    await untilCalls(sandbox, (calls) => {
      const statements = targetStatements(calls);
      const renamed = statements.findIndex((sql) => sql.startsWith(renamedIn));

      return (
        renamed !== -1 &&
        statements.slice(renamed).some((sql) => sql.startsWith(dropOld))
      );
    });
    process.kill(-run.child.pid, "SIGINT");
    const [code] = await run.exited;

    assert.equal(code, 130);
    assert.deepEqual(readDatabases(sandbox), [TARGET_DB, OLD_DB]);
    assert.ok(
      run.output.includes(
        [
          "Where the local data is now:",
          '  "launch_payload" is the copy of the source.',
          '  "launch_payload__pull_old" is your previous local database.',
          "The run stopped before it finished, so the app's after-script (its local admin, for one) did not run. Run 'pnpm db:pull' again.",
          `${COPY_NOTE} To delete the copied data, drop the database "launch_payload" on the server at localhost:5436.`,
        ].join("\n")
      ),
      run.output
    );
    // The old database may itself be an earlier pull's copy.
    assert.ok(run.output.includes(EARLIER_PULL_NOTE), run.output);
    assertNothingLeaked(sandbox, { stdout: run.output, stderr: "" });
  }
);

test(
  "Ctrl-C between the two renames says where both databases are",
  { timeout: SIGNAL_TEST_TIMEOUT_MS },
  async () => {
    const renameIn = `alter database "${SCRATCH_DB}" rename to`;
    const sandbox = makeSandbox({ hangSql: [renameIn] });
    const run = startScript(sandbox);

    await untilCalls(sandbox, (calls) =>
      targetStatements(calls).some((sql) => sql.startsWith(renameIn))
    );
    process.kill(-run.child.pid, "SIGINT");
    const [code] = await run.exited;

    assert.equal(code, 130);
    // Nothing was dropped: both the old data and the copy are still there.
    assert.deepEqual(readDatabases(sandbox), [OLD_DB, SCRATCH_DB].toSorted());
    assert.ok(
      run.output.includes(
        [
          "Where the local data is now:",
          '  "launch_payload" does not exist.',
          '  "launch_payload__pull_new" holds copied data that was not swapped in.',
          '  "launch_payload__pull_old" is your previous local database.',
          `Run 'pnpm db:pull' again to finish. To delete the copied data, drop the database "launch_payload__pull_new" on the server at localhost:5436.`,
        ].join("\n")
      ),
      run.output
    );
    assert.ok(run.output.includes(EARLIER_PULL_NOTE), run.output);
    assertNothingLeaked(sandbox, { stdout: run.output, stderr: "" });
  }
);

test("for the app's own target, the advice names DELETE_COMMAND; for another, the databases", () => {
  const own = runScript(
    {},
    {
      env: { PULL_DB_TARGET_URL: "" },
      layout: { config: { DELETE_COMMAND } },
    }
  ).result;

  const other = runScript(
    { databases: ["scratch-copy"] },
    {
      env: {
        PULL_DB_TARGET_URL: "postgres://dev:dev-pw@localhost:5999/scratch-copy",
      },
      layout: { config: { DELETE_COMMAND } },
    }
  ).result;

  assert.equal(own.status, 0, own.stderr);
  assert.ok(
    own.stdout.includes(
      `To delete the copied data, run: ${DELETE_COMMAND} (it removes every database on the app's local server).`
    ),
    own.stdout
  );
  assert.equal(other.status, 0, other.stderr);
  assert.ok(
    other.stdout.includes(
      'To delete the copied data, drop the database "scratch-copy" on the server at localhost:5999.'
    ),
    other.stdout
  );
  assert.ok(!other.stdout.includes(DELETE_COMMAND));
});

test("refuses settings and table lists it cannot use, before contacting anything", () => {
  const cases = [
    [{ config: { PSCALE_ORG: "" } }, /PSCALE_ORG must be letters/u],
    [
      { config: { PSCALE_DATABASE: "a b" } },
      /PSCALE_DATABASE must be letters/u,
    ],
    [{ config: { PG_MAJOR: "seventeen" } }, /PG_MAJOR must be a number/u],
    [{ config: { TARGET_URL: "" } }, /db-pull\.env has no TARGET_URL/u],
    [
      { config: { AFTER_SCRIPT: "../elsewhere.mjs" } },
      /AFTER_SCRIPT must be a path inside the app/u,
    ],
    [{ config: { AFTER_SCRIPT: "scripts/missing.mjs" } }, /does not exist/u],
    [{ config: { TYPO: "1" } }, /unknown setting 'TYPO'/u],
    [
      { tables: "content pages\nexcluded pages\n" },
      /both content and excluded: pages/u,
    ],
    [{ tables: "excluded users\n" }, /lists no content table/u],
    [{ tables: "content Pages\n" }, /not a table name/u],
    [{ tables: "copy pages\n" }, /must be 'content' or 'excluded'/u],
  ];

  for (const [layout, message] of cases) {
    const { calls, result } = runScript({}, { layout });

    assert.equal(result.status, 1, JSON.stringify(layout));
    assert.match(result.stderr, message, JSON.stringify(layout));
    assert.deepEqual(calls, [], JSON.stringify(layout));
  }
});

test("--branch copies another branch, and --migrate reaches the after-script", () => {
  const { calls, result } = runScript(
    { branch: "staging" },
    { args: ["--branch", "staging", "--migrate"] }
  );

  assert.equal(result.status, 0, result.stderr);
  const pscaleCalls = calls.filter((call) => call.program === "pscale");
  assert.ok(pscaleCalls.length > 0);

  for (const call of pscaleCalls) {
    assert.equal(call.args[3], "staging", call.args.join(" "));
  }

  assert.equal(afterCalls(calls)[0].env.PULL_DB_MIGRATE, "1");
});

test("a failing after-script fails the run, with the copy in place", () => {
  const { databases, result } = runScript({ failAfter: true });

  assert.equal(result.status, 1);
  assert.deepEqual(databases, [TARGET_DB]);
  assert.match(result.stderr, /scripts\/after\.mjs failed/u);
  assert.match(
    result.stdout,
    /The data is restored, but see the warnings above\./u
  );
});
