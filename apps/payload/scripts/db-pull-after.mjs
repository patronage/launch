// The last step of `pnpm db:pull` (AFTER_SCRIPT in db-pull.env): runs once
// the copy of PlanetScale's content is in place in the local Postgres.
//
// 1. Compares the copy's payload_migrations with src/migrations/postgres in
//    this checkout and on origin/main (after `git fetch origin main`). A row
//    with no file here is either on origin/main (this branch is behind main)
//    or unknown; both fail the run, because the restored schema is newer than
//    this code.
// 2. With PULL_DB_MIGRATE=1 (`pnpm db:pull --migrate`), runs this checkout's
//    pending migrations on the local copy.
// 3. Prints `pnpm payload migrate:status` for the local copy.
//
// Every Payload command it runs or prints is pinned to the local target with
// PAYLOAD_DB=postgres and POSTGRES_URL: a variable set in the environment wins
// over .env, so a PlanetScale URL there cannot redirect it.
//
// The copy has no users (db-pull.tables leaves them in PlanetScale). Open the
// admin on localhost to create the first one, which the local one-click
// sign-in then uses.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MIGRATIONS_DIR = path.join("src", "migrations", "postgres");
const MAIN_REMOTE = "origin";
const MAIN_BRANCH = "main";
const CONNECT_TIMEOUT_MS = 10_000;

// Batch -1 is the row Payload writes for a development schema push.
const MIGRATIONS_SQL =
  "select name from payload_migrations where batch <> -1 order by name";

const fail = (message) => {
  process.stderr.write(`db-pull-after: ${message}\n`);
  process.exit(1);
};

const warn = (message) => process.stderr.write(`Warning: ${message}\n`);

/** The target, refused unless it is a Postgres on this machine. */
const localTarget = (uri) => {
  if (/[?#]/u.test(uri)) {
    fail("PULL_DB_TARGET_URL must not have a query string or a fragment.");
  }

  let url;

  try {
    url = new URL(uri);
  } catch {
    fail("PULL_DB_TARGET_URL is not a URL.");
  }

  if (!LOCAL_HOSTS.has(url.hostname.replaceAll(/^\[|\]$/gu, ""))) {
    fail(`PULL_DB_TARGET_URL points at "${url.hostname}", not this machine.`);
  }

  return url;
};

const target = localTarget(process.env.PULL_DB_TARGET_URL ?? "");
const masked = new URL(target.href);

masked.password = "***";

/** The environment that pins the Payload CLI to the local copy. */
const pinnedEnv = {
  ...process.env,
  PAYLOAD_DB: "postgres",
  POSTGRES_URL: target.href,
};

delete pinnedEnv.PULL_DB_TARGET_URL;

const pinnedMigrateCommand = `PAYLOAD_DB=postgres POSTGRES_URL='${masked.href}' pnpm payload migrate  (put the local password in place of ***)`;

const payload = (...args) =>
  spawnSync("pnpm", ["payload", ...args], {
    env: pinnedEnv,
    stdio: ["ignore", "inherit", "inherit"],
  }).status === 0;

const sorted = (names) => [...new Set(names)].toSorted();

const checkoutMigrations = () =>
  sorted(
    readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".ts") && file !== "index.ts")
      .map((file) => file.slice(0, -".ts".length))
  );

const git = (...args) =>
  spawnSync("git", args, {
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Migration names on origin/main after a fetch, or null when unreadable. */
const mainMigrations = () => {
  if (git("rev-parse", "--is-inside-work-tree").status !== 0) {
    return { fetched: false, names: null };
  }

  const fetched =
    git(
      "fetch",
      "--quiet",
      MAIN_REMOTE,
      `+refs/heads/${MAIN_BRANCH}:refs/remotes/${MAIN_REMOTE}/${MAIN_BRANCH}`
    ).status === 0;

  if (!fetched) {
    warn(
      `could not fetch ${MAIN_REMOTE}/${MAIN_BRANCH}; comparing with its state at the last fetch.`
    );
  }

  const listed = git(
    "ls-tree",
    "--name-only",
    `${MAIN_REMOTE}/${MAIN_BRANCH}`,
    `${MIGRATIONS_DIR}/`
  );

  if (listed.status !== 0) {
    return { fetched, names: null };
  }

  return {
    fetched,
    names: sorted(
      listed.stdout
        .split("\n")
        .map((line) => path.basename(line))
        .filter((file) => file.endsWith(".ts") && file !== "index.ts")
        .map((file) => file.slice(0, -".ts".length))
    ),
  };
};

const databaseMigrations = async () => {
  const client = new Client({
    connectionString: target.href,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  await client.connect();

  try {
    const { rows } = await client.query(MIGRATIONS_SQL);

    return sorted(rows.map((row) => row.name));
  } finally {
    await client.end();
  }
};

/**
 * Compares the copy's migrations with this checkout's. Returns whether the
 * schema is safe for this code (no row the checkout lacks) and the
 * checkout's pending migrations.
 */
const compareMigrations = async () => {
  let inDatabase;

  try {
    inDatabase = await databaseMigrations();
  } catch (error) {
    fail(`could not read payload_migrations from the copy: ${error.message}`);
  }

  const inCheckout = checkoutMigrations();
  const onlyDatabase = inDatabase.filter((name) => !inCheckout.includes(name));
  const pending = inCheckout.filter((name) => !inDatabase.includes(name));

  if (onlyDatabase.length === 0 && pending.length === 0) {
    console.log(
      `payload_migrations matches ${MIGRATIONS_DIR}: ${inCheckout.length} migrations.`
    );

    return { ok: true, pending };
  }

  if (pending.length > 0) {
    console.log("This checkout has migrations the copy has not run:");

    for (const name of pending) {
      console.log(`  ${name}`);
    }
  }

  if (onlyDatabase.length === 0) {
    return { ok: true, pending };
  }

  const main = mainMigrations();
  const behind = onlyDatabase.filter((name) => main.names?.includes(name));
  const unknown = onlyDatabase.filter((name) => !main.names?.includes(name));

  if (behind.length > 0) {
    warn(
      `the copy has run migrations that are on ${MAIN_REMOTE}/${MAIN_BRANCH} and not in this checkout:\n${behind.map((name) => `  ${name}`).join("\n")}\nYour branch is behind ${MAIN_BRANCH}; update it before you run the app. The restored schema is newer than this code.`
    );
  }

  if (unknown.length > 0) {
    warn(
      `payload_migrations has rows with no migration file in this checkout or on ${MAIN_REMOTE}/${MAIN_BRANCH}:\n${unknown.map((name) => `  ${name}`).join("\n")}\n${main.names && main.fetched ? "The restored schema is newer than this code: the PlanetScale branch ran a migration that main does not have." : `${MAIN_REMOTE}/${MAIN_BRANCH} could not be read as it is now, so these may be migrations main has and this branch lacks. Run 'git fetch ${MAIN_REMOTE} ${MAIN_BRANCH}', then pull again.`}`
    );
  }

  return { ok: false, pending };
};

let status = 0;
const comparison = await compareMigrations();

if (!comparison.ok) {
  status = 1;
}

if (comparison.pending.length > 0) {
  if (process.env.PULL_DB_MIGRATE !== "1") {
    console.log(
      `Apply them to the local copy only, with:\n  ${pinnedMigrateCommand}\nor pull again with: pnpm db:pull --migrate`
    );
  } else if (comparison.ok) {
    console.log(
      `\nRunning this checkout's pending migrations on ${masked.href}...`
    );

    if (!payload("migrate")) {
      warn("the migrations failed on the local copy; see the output above.");
      status = 1;
    }
  } else {
    warn(
      "--migrate skipped: the restored schema is newer than this checkout. Update the branch, then pull again."
    );
  }
}

console.log(`\npnpm payload migrate:status (against ${masked.href}):`);

if (!payload("migrate:status")) {
  warn(
    "'pnpm payload migrate:status' failed. If dependencies are missing, run 'pnpm install'."
  );
  status = 1;
}

console.log(
  "\nThe copy has no users. Open the admin on localhost and create the first user; the local one-click sign-in then uses it."
);

process.exit(status);
