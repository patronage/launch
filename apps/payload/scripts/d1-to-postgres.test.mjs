// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// Unit tests for scripts/d1-to-postgres.mjs. Run by `pnpm test`; the copy
// itself is covered end to end by scripts/d1-to-postgres-e2e.test.mjs.
import assert from "node:assert/strict";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import {
  CopyError,
  SKIPPED_TABLES,
  cfSource,
  convert,
  copyPlan,
  loadSchema,
  migrationKey,
  parseCfQuery,
  productionD1Id,
} from "./d1-to-postgres.mjs";

const schema = loadSchema();
const plan = copyPlan(schema);
const position = new Map(plan.map((table, index) => [table.name, index]));

test("the plan copies every table but the skipped ones", () => {
  const names = schema.map((table) => table.name);

  for (const skipped of SKIPPED_TABLES) {
    assert.ok(names.includes(skipped), `${skipped} is not in the schema`);
    assert.ok(!position.has(skipped), skipped);
  }

  assert.equal(plan.length, names.length - SKIPPED_TABLES.size);
  assert.ok(position.has("users") && position.has("form_submissions"));
});

test("every table comes after the tables it points at", () => {
  for (const table of plan) {
    for (const key of table.foreignKeys) {
      if (key.table !== table.name) {
        assert.ok(
          position.get(key.table) < position.get(table.name),
          `${table.name} -> ${key.table}`
        );
      }
    }
  }
});

test("links to the same table are deferred", () => {
  const pages = plan.find((table) => table.name === "pages");

  assert.deepEqual(pages.deferred, ["parent_id"]);
});

const fakeTable = (name, to) => ({
  columns: [{ name: "id", type: "serial" }],
  foreignKeys: to ? [{ columns: [`${to}_id`], table: to }] : [],
  name,
});

test("a foreign-key cycle or a link to a skipped table is refused", () => {
  assert.throws(() => copyPlan([fakeTable("a", "b"), fakeTable("b", "a")]), {
    message: /cycle/u,
    name: "CopyError",
  });
  assert.throws(
    () =>
      copyPlan([fakeTable("a", "users_sessions"), fakeTable("users_sessions")]),
    /which the copy skips/u
  );
});

test("values are converted for their Postgres column type", () => {
  assert.equal(convert(1, "boolean"), true);
  assert.equal(convert(0, "boolean"), false);
  assert.equal(convert("1", "boolean"), true);
  assert.equal(convert(null, "boolean"), null);
  assert.throws(() => convert(2, "boolean"), CopyError);
  assert.equal(convert('{"a":1}', "jsonb"), '{"a":1}');
  assert.equal(convert({ a: 1 }, "jsonb"), '{"a":1}');
  assert.throws(() => convert("not json", "jsonb"), SyntaxError);
  assert.equal(convert(12n, "integer"), "12");
  assert.equal(
    convert("2026-11-13T04:00:00.000Z", "timestamp(3) with time zone"),
    "2026-11-13T04:00:00.000Z"
  );
  assert.equal(convert(undefined, "varchar"), null);
});

test("migration names compare without their timestamps", () => {
  assert.equal(migrationKey("20261029_201036_initial"), "initial");
  assert.equal(migrationKey("20261110_222857_seo_redirects"), "seo_redirects");
});

test("cf d1 query output is read with or without the API envelope", () => {
  const results = [{ n: 3 }];

  assert.deepEqual(
    parseCfQuery(JSON.stringify([{ results, success: true }])),
    results
  );
  assert.deepEqual(
    parseCfQuery(JSON.stringify({ result: [{ results }], success: true })),
    results
  );
  assert.deepEqual(parseCfQuery(JSON.stringify({ results })), results);
  assert.throws(() => parseCfQuery("{}"), CopyError);
  assert.throws(
    () => parseCfQuery(JSON.stringify([{ results, success: false }])),
    CopyError
  );
});

test("the cf source pages with SELECTs on the production database", () => {
  const calls = [];

  const spawn = (program, args) => {
    calls.push([program, ...args]);

    return {
      status: 0,
      stdout: JSON.stringify([{ results: [{ id: 1 }], success: true }]),
    };
  };

  const source = cfSource("8503df2d-e2f5-45ec-8bf3-8fec186b2a95", spawn);

  assert.deepEqual(source.rows("pages", 500, 500), [{ id: 1 }]);
  assert.deepEqual(calls[0], [
    "pnpm",
    "exec",
    "cf",
    "d1",
    "query",
    "8503df2d-e2f5-45ec-8bf3-8fec186b2a95",
    "--sql",
    'select * from "pages" order by rowid limit ? offset ?',
    "--params",
    "500",
    "500",
  ]);
  assert.throws(() => source.count("pages; drop table pages"), CopyError);

  const failing = cfSource("x", () => ({ status: 1, stderr: "not signed in" }));
  assert.throws(() => failing.count("pages"), /cf d1 query failed/u);
});

test("the production D1 id is the one cloudflare.config.ts binds", () => {
  assert.equal(productionD1Id(), "8503df2d-e2f5-45ec-8bf3-8fec186b2a95");
});
