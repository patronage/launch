// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// Checks db-pull.tables against the Postgres schema the migrations build: the
// schema snapshot that `pnpm payload migrate:create` writes next to the newest
// migration. Run by `pnpm test`.
//
// It fails when a table is on neither list (a new collection, field or plugin
// table that nobody classified), on both, or listed and missing from the
// schema. It also checks what pull-postgres.sh checks on PlanetScale before
// each dump: every foreign key from a content table to an excluded one can be
// cleared, because it is one column and ON DELETE CASCADE (on a table nothing
// points at) or SET NULL.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

const APP_DIR = path.join(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(APP_DIR, "src", "migrations", "postgres");

// Users, sessions and visitors' answers must never be copied.
const MUST_BE_EXCLUDED = [
  "users",
  "users_sessions",
  "form_submissions",
  "form_submissions_submission_data",
  "payload_preferences",
];

const readLists = () => {
  const lists = { content: [], excluded: [] };
  const text = readFileSync(path.join(APP_DIR, "db-pull.tables"), "utf-8");

  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/u, "").trim();

    if (line === "") {
      continue;
    }

    const [kind, table, ...rest] = line.split(/\s+/u);
    assert.ok(kind in lists && /^[a-z0-9_]+$/u.test(table ?? ""), raw);
    assert.deepEqual(rest, [], raw);
    lists[kind].push(table);
  }

  return lists;
};

const newestSnapshot = () => {
  const [newest] = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{8}_\d{6}_.+\.json$/u.test(file))
    .toSorted()
    .toReversed();

  assert.ok(newest, "no migration snapshot");

  return JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, newest), "utf-8"));
};

const lists = readLists();
const snapshot = newestSnapshot();
const tables = Object.values(snapshot.tables);
const names = new Set(tables.map((table) => table.name));
const content = new Set(lists.content);
const excluded = new Set(lists.excluded);

test("every table in the schema is classified once", () => {
  assert.deepEqual(
    [...names].filter((name) => !(content.has(name) || excluded.has(name))),
    [],
    "add these tables to db-pull.tables as content or excluded"
  );
  assert.deepEqual(
    lists.content.filter((name) => excluded.has(name)),
    []
  );
  assert.equal(new Set(lists.content).size, lists.content.length);
  assert.equal(new Set(lists.excluded).size, lists.excluded.length);
  assert.deepEqual(
    [...content, ...excluded].filter((name) => !names.has(name)),
    [],
    "db-pull.tables lists tables the schema does not have"
  );
});

test("users, sessions and form submissions are excluded", () => {
  for (const name of MUST_BE_EXCLUDED) {
    assert.ok(excluded.has(name), name);
  }
});

test("every link from content to an excluded table can be cleared", () => {
  const referenced = new Set(
    tables.flatMap((table) =>
      Object.values(table.foreignKeys ?? {}).map((key) => key.tableTo)
    )
  );

  for (const table of tables.filter((entry) => content.has(entry.name))) {
    for (const key of Object.values(table.foreignKeys ?? {})) {
      if (!excluded.has(key.tableTo)) {
        continue;
      }

      const where = `${table.name}.${key.columnsFrom.join(",")}`;
      assert.equal(key.columnsFrom.length, 1, where);
      assert.ok(["cascade", "set null"].includes(key.onDelete), where);

      if (key.onDelete === "cascade") {
        assert.ok(!referenced.has(table.name), `${where}: others point at it`);
      }
    }
  }
});
