// Prints an identity for the Postgres server that PULL_DB_SERVER_URL reaches
// from this machine: its system identifier and the time it started.
//
// pull-postgres.sh restores through Docker, which reaches the target as
// host.docker.internal, and then runs the app's after-script on this machine,
// which reaches it as localhost. Those two addresses can lead to
// different servers. The script asks both ways with the same query and stops
// unless the answers match.
//
// It connects to the `postgres` database, because the target database may
// not exist yet, and refuses any server that is not on this machine.

import { Client } from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const CONNECT_TIMEOUT_MS = 10_000;

// Keep in step with SERVER_ID_SQL in pull-postgres.sh.
const SERVER_ID_SQL =
  "select (select system_identifier::text from pg_control_system()) || ' ' || extract(epoch from pg_postmaster_start_time())::text as id";

const uri = process.env.PULL_DB_SERVER_URL ?? "";

if (/[?#]/u.test(uri)) {
  throw new Error(
    "PULL_DB_SERVER_URL must not have a query string or a fragment."
  );
}

const url = new URL(uri);
const host = url.hostname.replaceAll(/^\[|\]$/gu, "");

if (!LOCAL_HOSTS.has(host)) {
  throw new Error(
    `PULL_DB_SERVER_URL points at "${host}", not at this machine.`
  );
}

url.pathname = "/postgres";

const client = new Client({
  connectionString: url.href,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
});

await client.connect();

try {
  const { rows } = await client.query(SERVER_ID_SQL);
  console.log(rows[0].id);
} finally {
  await client.end();
}
