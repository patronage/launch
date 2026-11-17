// oxlint-disable func-style, complexity, anti-slop/no-array-filter-map -- A test stand-in for several programs, kept close to the one it was ported from.
/**
 * Test stand-in for the programs pull-postgres.sh runs: `pscale`, `docker`,
 * server-id.mjs and the app's after-script. pull-postgres.test.mjs puts
 * wrappers named `pscale` and `docker` on PATH that call this file with that
 * name first, and copies it in as server-id.mjs and as the after-script.
 *
 * STUB_DIR holds the shared state:
 * - `calls.jsonl`: one line per call, with its arguments and the database
 *   settings in its environment.
 * - `roles.json`: the roles "PlanetScale" has now.
 * - `databases.json`: the databases the local server has now.
 * - `dump-tables.json`: the tables whose rows pg_dump was told to dump.
 * - `scenario.json`: what the test wants to go wrong.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// pull-prod-db.test.mjs checks that this never shows up in output or arguments.
const STUB_ROLE_PASSWORD = "pscale_pw_stub-secret-never-print-me";
const STUB_ROLE_ID = "stubrole1234";
const STUB_SERVER_ID = "7300000000000000001 1794400000.123456";
const SOURCE_HOST = "stub.pg.psdb.cloud";
const TARGET_DATABASE = "launch_payload";
const OLD_DATABASE = `${TARGET_DATABASE}__pull_old`;
const LOCAL_DOCKER_ENDPOINT = "unix:///var/run/docker.sock";

const RECORDED_ENV = /^(?:PG|PULL_DB_)/u;

const POSTGRES_IMAGE = /^postgres:\d+$/u;
const HANG_MS = 600_000;
const DROP_DATABASE = /^drop database (?:if exists )?"(?<name>[^"]+)"/u;
const CREATE_DATABASE = /^create database "(?<name>[^"]+)"/u;

const RENAME_DATABASE =
  /^alter database "(?<from>[^"]+)" rename to "(?<to>[^"]+)"/u;

const DATABASE_EXISTS = /from pg_database where datname = '(?<name>[^']+)'/u;

const DATABASES_AMONG =
  /from pg_database where datname in \((?<names>[^)]+)\)/u;

const stubDir = process.env.STUB_DIR ?? "";
const rolesFile = path.join(stubDir, "roles.json");
const databasesFile = path.join(stubDir, "databases.json");
const dumpTablesFile = path.join(stubDir, "dump-tables.json");

// The source's tables, unless the scenario names others: two content tables,
// payload_migrations, and three whose rows must stay in PlanetScale.
const SOURCE_TABLES = [
  "form_submissions",
  "pages",
  "pages_rels",
  "payload_migrations",
  "users",
  "users_sessions",
];

// Foreign keys from a copied table to a left-out one: table, column, ON
// DELETE action, columns in the key, foreign keys that point at the table.
const SOURCE_LINKS = ["pages_rels users_id c 1 0"];
const DUMP_TABLE = /^--table=public\.(?<name>.+)$/u;
const ASKED_WHETHER_EMPTY = /select '(?<name>[^']+)' where exists/gu;
const callsFile = path.join(stubDir, "calls.jsonl");

const scenario = JSON.parse(
  readFileSync(path.join(stubDir, "scenario.json"), "utf-8")
);

function readRoles() {
  return existsSync(rolesFile)
    ? JSON.parse(readFileSync(rolesFile, "utf-8"))
    : (scenario.existingRoles ?? []);
}

function record(program, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => RECORDED_ENV.test(name))
  );

  // Which daemon a docker command would have talked to.
  const daemon = {
    context: process.env.DOCKER_CONTEXT,
    host: process.env.DOCKER_HOST,
  };

  appendFileSync(
    callsFile,
    `${JSON.stringify({ program, args, env, daemon })}\n`
  );
}

function readDatabases() {
  return existsSync(databasesFile)
    ? JSON.parse(readFileSync(databasesFile, "utf-8"))
    : (scenario.databases ?? [TARGET_DATABASE]);
}

function writeDatabases(databases) {
  writeFileSync(databasesFile, JSON.stringify(databases));
}

/**
 * Answers the check that the left-out tables are empty in the copy, the way
 * a real restore would: a table the check asks about holds rows when the
 * dump of rows named it, or when pg_dump was not limited to named tables at
 * all. `scenario.rowsLeftIn` names tables that hold rows anyway.
 */
function tablesHoldingRows(sql) {
  const dumped = existsSync(dumpTablesFile)
    ? new Set(JSON.parse(readFileSync(dumpTablesFile, "utf-8")))
    : null;

  const left = new Set(scenario.rowsLeftIn);

  return [...sql.matchAll(ASKED_WHETHER_EMPTY)]
    .map((match) => match.groups.name)
    .filter((name) => dumped === null || dumped.has(name) || left.has(name));
}

/** How many `pscale role delete` calls the log holds, this one included. */
function deleteCallsSoFar() {
  return readFileSync(callsFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((call) => call.program === "pscale" && call.args[1] === "delete")
    .length;
}

function hang() {
  setTimeout(() => {
    // Keeps the process alive until the test signals it.
  }, HANG_MS);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function pscale(args) {
  const [group, command, database, branch, subject] = args;

  if (
    group !== "role" ||
    database !== "demo-db" ||
    branch !== (scenario.branch ?? "main")
  ) {
    fail(`stub pscale: unexpected ${args.join(" ")}`);
  }

  const roles = readRoles();

  if (command === "list") {
    if (scenario.failList) {
      fail("stub pscale: not authenticated");
    }

    if (args.includes("--name")) {
      // An older pscale build has no such flag.
      fail("stub pscale: unknown flag: --name");
    }

    console.log(JSON.stringify(roles));

    return;
  }

  if (command === "create") {
    if (scenario.failCreate) {
      fail("stub pscale: create refused");
    }

    writeFileSync(
      rolesFile,
      JSON.stringify([...roles, { id: STUB_ROLE_ID, name: subject }])
    );

    if (scenario.createAnswersNothing) {
      // The role exists, but the script never learns its id.
      process.exit(1);
    }

    console.log(
      JSON.stringify({
        id: STUB_ROLE_ID,
        name: subject,
        username: `pscale_api_${STUB_ROLE_ID}.branch`,
        password: STUB_ROLE_PASSWORD,
        access_host_url: SOURCE_HOST,
      })
    );

    return;
  }

  if (command === "delete") {
    if (
      scenario.failDelete ||
      deleteCallsSoFar() <= (scenario.failDeleteTimes ?? 0) ||
      !args.includes("--force")
    ) {
      fail("stub pscale: delete refused");
    }

    writeFileSync(
      rolesFile,
      JSON.stringify(roles.filter((role) => role.id !== subject))
    );

    return;
  }

  fail(`stub pscale: unexpected ${args.join(" ")}`);
}

/** Applies one statement to the stub's databases, as Postgres would. */
function databaseStatement(sql) {
  const databases = readDatabases();
  const drop = DROP_DATABASE.exec(sql);

  if (drop) {
    const { name } = drop.groups;

    if (
      scenario.failDropOldAfterSwap &&
      name === OLD_DATABASE &&
      databases.includes(name)
    ) {
      fail(`ERROR:  database "${name}" is being accessed by other users`);
    }

    writeDatabases(databases.filter((database) => database !== name));

    return true;
  }

  const create = CREATE_DATABASE.exec(sql);

  if (create) {
    if (databases.includes(create.groups.name)) {
      fail(`ERROR:  database "${create.groups.name}" already exists`);
    }

    writeDatabases([...databases, create.groups.name]);

    return true;
  }

  const rename = RENAME_DATABASE.exec(sql);

  if (rename) {
    const { from, to } = rename.groups;

    if (!databases.includes(from)) {
      fail(`ERROR:  database "${from}" does not exist`);
    }

    if (databases.includes(to)) {
      fail(`ERROR:  database "${to}" already exists`);
    }

    writeDatabases(
      databases.map((database) => (database === from ? to : database))
    );

    return true;
  }

  const exists = DATABASE_EXISTS.exec(sql);

  if (exists) {
    console.log(databases.includes(exists.groups.name) ? 1 : 0);

    return true;
  }

  const among = DATABASES_AMONG.exec(sql);

  if (among) {
    const names = new Set(
      among.groups.names
        .split(",")
        .map((name) => name.trim().replaceAll("'", ""))
    );

    for (const database of databases.filter((name) => names.has(name))) {
      console.log(database);
    }

    return true;
  }

  return false;
}

/** Answers one statement. Returns false to keep the process alive (a hang). */
function psqlStatement(sql) {
  if ((scenario.failSql ?? []).some((part) => sql.includes(part))) {
    fail(`ERROR:  stub failure for: ${sql}`);
  }

  if ((scenario.hangSql ?? []).some((part) => sql.includes(part))) {
    hang();

    return false;
  }

  if (
    scenario.hangDropOldAfterSwap &&
    DROP_DATABASE.exec(sql)?.groups.name === OLD_DATABASE &&
    readDatabases().includes(OLD_DATABASE)
  ) {
    hang();

    return false;
  }

  const onSource = process.env.PGHOST === SOURCE_HOST;

  if (sql.includes("pg_postmaster_start_time")) {
    console.log(scenario.dockerServerId ?? STUB_SERVER_ID);

    return true;
  }

  if (sql.includes("server_version_num")) {
    if (!onSource) {
      console.log(scenario.targetMajor ?? 17);

      return true;
    }

    if (scenario.sourceRefusesLogin) {
      fail("psql: error: password authentication failed");
    }

    console.log(
      `${scenario.sourceMajor ?? 17} ${scenario.roleCanWrite ? "t" : "f"} 147`
    );

    return true;
  }

  if (databaseStatement(sql)) {
    return true;
  }

  if (sql.includes("pg_terminate_backend")) {
    console.log("t");
  } else if (sql.includes("select tablename from pg_tables")) {
    const sourceTables = scenario.sourceTables ?? SOURCE_TABLES;
    console.log(
      (onSource
        ? sourceTables
        : (scenario.restoredTableNames ?? sourceTables)
      ).join("\n")
    );
  } else if (sql.includes("from pg_constraint")) {
    console.log((scenario.sourceLinks ?? SOURCE_LINKS).join("\n"));
  } else if (sql.includes("where exists (select 1 from")) {
    const holding = tablesHoldingRows(sql);

    if (holding.length > 0) {
      console.log(holding.join("\n"));
    }
  } else if (sql.includes("from payload_migrations")) {
    console.log((scenario.databaseMigrations ?? []).join("\n"));
  } else if (sql.includes("from pg_tables")) {
    console.log(scenario.restoredTables ?? 147);
  }

  return true;
}

/** Runs the statements in order and stops at the first that hangs. */
function psql(statements) {
  for (const sql of statements) {
    if (!psqlStatement(sql)) {
      return;
    }
  }
}

function docker(args) {
  if (args[0] === "info") {
    if (scenario.dockerDown) {
      fail("stub docker: daemon not running");
    }

    return;
  }

  if (args[0] === "context" && args[1] === "inspect") {
    if (scenario.dockerContextFails) {
      fail("stub docker: context not found");
    }

    console.log(scenario.dockerEndpoint ?? LOCAL_DOCKER_ENDPOINT);

    return;
  }

  const imageAt = args.findIndex((arg) => POSTGRES_IMAGE.test(arg));

  if (args[0] !== "run" || imageAt === -1) {
    fail(`stub docker: unexpected ${args.join(" ")}`);
  }

  const [tool, ...toolArgs] = args.slice(imageAt + 1);

  if (tool === "psql") {
    psql(toolArgs.filter((_arg, at) => toolArgs[at - 1] === "--command"));

    return;
  }

  if (tool === "pg_dump") {
    if (scenario.failDump) {
      fail("pg_dump: error: stub failure");
    }

    if (scenario.hangDump) {
      hang();

      return;
    }

    if (toolArgs.includes("--schema-only")) {
      process.stdout.write("PGDMP stub dump of definitions");

      return;
    }

    if (scenario.failRowsDump) {
      fail("pg_dump: error: stub failure in the dump of rows");
    }

    // A dump with no --table names every table's rows: null, not [].
    const named = toolArgs
      .map((arg) => DUMP_TABLE.exec(arg)?.groups.name)
      .filter(Boolean);

    writeFileSync(
      dumpTablesFile,
      JSON.stringify(named.length > 0 ? named : null)
    );
    process.stdout.write("PGDMP stub dump");

    return;
  }

  if (tool === "pg_restore") {
    // The last of the three calls adds the indexes and foreign keys.
    if (toolArgs.includes("--section=post-data")) {
      if (scenario.failPostData) {
        fail("pg_restore: error: stub failure in post-data");
      }

      process.stdin.resume();

      return;
    }

    if (scenario.failRestore) {
      fail("pg_restore: error: stub failure");
    }

    if (scenario.hangRestore) {
      hang();

      return;
    }

    process.stdin.resume();

    return;
  }

  fail(`stub docker: unexpected tool ${tool}`);
}

const [program, ...args] = process.argv.slice(2);

if (path.basename(process.argv[1]) === "server-id.mjs") {
  // Copied in as the kit's server-id.mjs: the server this machine reaches at
  // the target address.
  record("server-id", process.argv.slice(2));

  if (scenario.failServerId) {
    fail("stub server-id: connection refused");
  }

  console.log(scenario.hostServerId ?? STUB_SERVER_ID);
} else if (program === "pscale") {
  record("pscale", args);
  pscale(args);
} else if (program === "docker") {
  record("docker", args);
  docker(args);
} else {
  // Copied in as the app's after-script.
  record("after", process.argv.slice(2));

  if (scenario.hangAfter) {
    hang();
  } else if (scenario.failAfter) {
    fail("stub after-script: failed");
  } else {
    console.log("stub after-script ran");
  }
}
