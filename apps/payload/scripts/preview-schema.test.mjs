// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// Unit tests for scripts/preview-schema.mjs, and the rule that keeps branch
// preview schemas working: no committed Postgres migration names a schema.
// Run by `pnpm test`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import {
  SCHEMA_PATTERN,
  checkSchemaName,
  decide,
  migrateEnv,
  schemaForBranch,
  schemaUrl,
} from "./preview-schema.mjs";

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "src", "migrations", "postgres");

test("no Postgres migration names the public schema", () => {
  const qualified = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) =>
      readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8").includes(
        '"public".'
      )
    );

  // Payload's migrate:create writes "public"."name"; `pnpm migrate:create`
  // deletes the prefix (see the README), so the migration lands in whatever
  // search_path names.
  assert.deepEqual(qualified, []);
});

test("a branch maps to one short schema that src/db.ts accepts", () => {
  const schema = schemaForBranch("claude/project-thread-qh6lu6");
  const dbSource = readFileSync(path.join(APP_DIR, "src", "db.ts"), "utf-8");

  assert.match(schema, SCHEMA_PATTERN);
  assert.equal(schemaForBranch("claude/project-thread-qh6lu6"), schema);
  assert.notEqual(schemaForBranch("main"), schema);
  assert.ok(schema.length < 63);
  assert.ok(dbSource.includes(SCHEMA_PATTERN.source));
  assert.throws(() => schemaForBranch(" "), /branch name is required/u);
});

test("schema names outside the pattern are refused", () => {
  for (const name of [
    "public",
    "preview_xyz",
    "pr_1; drop schema public",
    "",
  ]) {
    assert.throws(() => checkSchemaName(name), /looks like preview_/u);
  }
});

test("a branch without new migrations reads the shared copy", () => {
  assert.deepEqual(decide({ branch: ["a", "b"], shared: ["a", "b"] }), {
    behind: [],
    mode: "public",
  });
  assert.deepEqual(decide({ branch: ["a"], shared: ["a", "b"] }), {
    behind: ["b"],
    mode: "public",
  });
});

test("a branch with new migrations gets a schema, if it is up to date", () => {
  assert.deepEqual(
    decide({ branch: ["1_a", "2_b", "3_c"], shared: ["1_a", "2_b"] }),
    { added: ["3_c"], mode: "schema" }
  );
  assert.throws(
    () => decide({ branch: ["1_a", "3_c"], shared: ["1_a", "2_b"] }),
    /Merge main into the branch/u
  );
  assert.throws(
    () => decide({ branch: ["1_a", "1_z", "2_b"], shared: ["1_a", "2_b"] }),
    /sort before 2_b/u
  );
});

test("the migration URL sets search_path to the schema", () => {
  const schema = schemaForBranch("feature");

  const url = new URL(
    schemaUrl("postgres://u:p@host:5432/postgres?sslmode=verify-full", schema)
  );

  assert.equal(url.searchParams.get("options"), `-c search_path=${schema}`);
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
});

test("migrations get a throwaway secret when the build has none", () => {
  const args = {
    schema: schemaForBranch("feature"),
    url: "postgres://u:p@host:5432/postgres",
  };

  const without = migrateEnv({ ...args, env: { PATH: "/bin" } });

  assert.match(without.PAYLOAD_SECRET, /^[0-9a-f]{64}$/u);
  assert.equal(without.PAYLOAD_DB_SCHEMA, args.schema);
  assert.equal(
    migrateEnv({ ...args, env: { PAYLOAD_SECRET: "set" } }).PAYLOAD_SECRET,
    "set"
  );
});
