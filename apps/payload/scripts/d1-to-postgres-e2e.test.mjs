// oxlint-disable vitest/prefer-importing-vitest-globals, func-style, no-await-in-loop -- An opt-in Node test runner suite that polls a container.
/**
 * Runs `pnpm d1:copy` (scripts/d1-to-postgres.mjs) from start to finish: a
 * throwaway local D1, migrated and seeded with the demo site plus a user and
 * a form submission, copied into a throwaway Postgres 17 container that the
 * Payload CLI migrated. Nothing here contacts Cloudflare or PlanetScale.
 *
 * It fails unless Payload reads the same documents, drafts, versions and
 * globals from both databases, the user can sign in on Postgres with the same
 * password, a new document gets the next id, and a second copy into the now
 * full database is refused.
 *
 * Run from apps/payload, after `pnpm install`, with a PAYLOAD_SECRET in the
 * environment or .env:
 *
 *   D1_COPY_E2E=1 node --test scripts/d1-to-postgres-e2e.test.mjs
 *
 * Without D1_COPY_E2E=1 the suite is skipped. It needs Docker, and starts one
 * container named d1-copy-e2e-<pid> with --rm, removed with `docker rm -fv`
 * when it ends. The D1 lives in a temporary folder (PAYLOAD_LOCAL_STATE), so
 * the app's own local state is left alone.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const APP_DIR = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(import.meta.dirname, "d1-to-postgres.mjs");
const DUMP = "scripts/fixtures/dump-content.ts";
const EXTRA = "scripts/fixtures/d1-copy-e2e-extra.ts";

const enabled = process.env.D1_COPY_E2E === "1";
const CONTAINER = `d1-copy-e2e-${process.pid}`;
const PASSWORD = "e2e-target-pw";
const READY_ATTEMPTS = 60;
const READY_WAIT_MS = 1000;
const SUITE_TIMEOUT_MS = 900_000;
const MAX_BUFFER = 256 * 1024 * 1024;

let dir = "";
let targetUrl = "";
let d1Env = {};
let pgEnv = {};

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

/** Payload's view of every document. (jsonb reorders keys; deepEqual ignores order.) */
function dump(env, name) {
  const file = path.join(dir, `${name}.json`);
  command("pnpm", ["-s", "payload", "run", DUMP, file], { env });

  return JSON.parse(readFileSync(file, "utf-8"));
}

function copyTo(extra = []) {
  const file = readdirSync(
    path.join(dir, "state", "d1", "miniflare-D1DatabaseObject")
  ).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");

  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--sqlite",
      path.join(dir, "state", "d1", "miniflare-D1DatabaseObject", file),
      "--target",
      targetUrl,
      ...extra,
    ],
    { cwd: APP_DIR, encoding: "utf-8" }
  );
}

before(
  async () => {
    if (!enabled) {
      return;
    }

    dir = mkdtempSync(path.join(tmpdir(), "d1-copy-e2e-"));
    const port = await freePort();
    targetUrl = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/launch_payload`;

    const base = {
      ...process.env,
      PAYLOAD_LOCAL_STATE: path.join(dir, "state"),
    };

    delete base.PAYLOAD_DB;
    delete base.POSTGRES_URL;
    d1Env = base;
    pgEnv = { ...base, PAYLOAD_DB: "postgres", POSTGRES_URL: targetUrl };

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

    command("pnpm", ["-s", "payload", "migrate"], { env: d1Env });
    command("pnpm", ["-s", "seed"], { env: d1Env });
    command("pnpm", ["-s", "payload", "run", EXTRA], { env: d1Env });
    command("pnpm", ["-s", "payload", "migrate"], { env: pgEnv });
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
  "copies D1 into Postgres so Payload reads the same content",
  { skip: !enabled && "set D1_COPY_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const dry = copyTo(["--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run: nothing was written\./u);

    const run = copyTo();
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Every table's count matches the source\./u);
    assert.doesNotMatch(run.stdout, new RegExp(PASSWORD, "u"));

    const fromD1 = dump(d1Env, "d1");
    const fromPostgres = dump(pgEnv, "postgres");
    assert.ok(fromD1.pages.length > 0 && fromD1.users.length === 1);
    assert.equal(fromD1["form-submissions"].length, 1);
    assert.deepEqual(fromPostgres, fromD1);
  }
);

test(
  "the user signs in on Postgres and new documents get the next id",
  { skip: !enabled && "set D1_COPY_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const ids = dump(pgEnv, "before-check").categories.map(
      (category) => category.id
    );

    const file = path.join(dir, "check.json");
    command("pnpm", ["-s", "payload", "run", EXTRA, "check", file], {
      env: pgEnv,
    });
    const result = JSON.parse(readFileSync(file, "utf-8"));

    assert.equal(result.signedIn, true);
    assert.equal(result.categoryId, Math.max(...ids) + 1);
  }
);

test(
  "a second copy into the full database is refused",
  { skip: !enabled && "set D1_COPY_E2E=1", timeout: SUITE_TIMEOUT_MS },
  () => {
    const again = copyTo();
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already has rows/u);
  }
);
