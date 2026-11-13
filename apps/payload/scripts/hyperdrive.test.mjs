// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// Unit tests for scripts/hyperdrive.mjs, with a stand-in for the cf CLI.
import assert from "node:assert/strict";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import {
  configName,
  configureHyperdrive,
  planetScaleSettings,
} from "./hyperdrive.mjs";

const root = path.join(import.meta.dirname, "..");

const context = (argv, existing = []) => {
  const calls = [];
  const lines = [];

  return {
    calls,
    ctx: {
      argv,
      env: {},
      fetch,
      log: (line) => lines.push(line),
      root,
      spawn: (command, args) => {
        calls.push(args.slice(2, 5).join(" "));

        if (args[3] === "list") {
          return { status: 0, stdout: JSON.stringify(existing) };
        }

        if (args[3] === "create") {
          return { status: 0, stdout: JSON.stringify({ id: "new-id" }) };
        }

        return { status: 0 };
      },
      warn: () => {},
    },
    lines,
  };
};

test("db-pull.env names the PlanetScale database", () => {
  assert.deepEqual(
    planetScaleSettings(
      "# c\nPSCALE_ORG=org\nPSCALE_DATABASE=db\nPSCALE_BRANCH=main\nPG_MAJOR=17\n"
    ),
    { branch: "main", database: "db", organization: "org" }
  );
  assert.throws(
    () => planetScaleSettings("PSCALE_ORG=org\n"),
    /PSCALE_DATABASE/u
  );
});

test("the default branch's configuration is named after the database", () => {
  assert.equal(configName("launch-payload", "main", "main"), "launch-payload");
  assert.equal(
    configName("launch-payload", "staging", "main"),
    "launch-payload-staging"
  );
});

test("creates the configuration with the managed integration and no cache", () => {
  const run = context([]);

  configureHyperdrive(run.ctx);

  assert.deepEqual(run.calls, [
    "hyperdrive list --per-page",
    "hyperdrive create --name",
    "hyperdrive update new-id",
  ]);
  assert.match(run.lines.at(-1), /HYPERDRIVE_ID=new-id/u);
});

test("an existing configuration is reused, and a dry run changes nothing", () => {
  const existing = context([], [{ id: "old-id", name: "launch-payload" }]);
  configureHyperdrive(existing.ctx);
  assert.deepEqual(existing.calls, [
    "hyperdrive list --per-page",
    "hyperdrive update old-id",
  ]);

  const dry = context(["--dry-run", "--branch", "staging"]);
  configureHyperdrive(dry.ctx);
  assert.deepEqual(dry.calls, ["hyperdrive list --per-page"]);
  assert.match(dry.lines[0], /--name launch-payload-staging/u);
  assert.match(dry.lines.at(-1), /Dry run/u);
});

test("a branch name that is not one is refused", () => {
  assert.throws(
    () => configureHyperdrive(context(["--branch", "main;rm"]).ctx),
    /not a PlanetScale branch name/u
  );
});
