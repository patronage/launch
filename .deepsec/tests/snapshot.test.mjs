// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
// The scanner tests deliberately have no app or test-runner dependencies.
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import { launchMatchers } from "../matchers.mjs";
import { prepareSnapshot } from "../scripts/snapshot.mjs";

const fixture = (t) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "launch-snapshot-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const root = nodePath.join(directory, "repo");
  const output = nodePath.join(directory, "output");
  mkdirSync(root);
  mkdirSync(output);

  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

  git("init");
  git("config", "user.name", "Snapshot test");
  git("config", "user.email", "test@example.invalid");

  const commit = () => {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  };

  writeFileSync(nodePath.join(root, "source.js"), "export const value = 1;\n");

  return { commit, output, root };
};

test("snapshot includes committed bytes and internal links, excluding local secrets and edits", (t) => {
  const { root, output, commit } = fixture(t);
  symlinkSync("source.js", nodePath.join(root, "linked.js"));
  commit();
  writeFileSync(nodePath.join(root, "source.js"), "uncommitted change");
  writeFileSync(nodePath.join(root, ".env"), "SECRET=local-only");
  const manifest = prepareSnapshot(root, output);
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ["linked.js", "source.js"]
  );
});

test("rejects a tracked secret path", (t) => {
  const { root, output, commit } = fixture(t);
  writeFileSync(nodePath.join(root, ".env.local"), "SECRET=fixture");
  commit();
  assert.throws(
    () => prepareSnapshot(root, output),
    /Credential-bearing path/u
  );
});

test("rejects escaping symlinks before extraction", (t) => {
  const { root, output, commit } = fixture(t);
  symlinkSync("../../outside", nodePath.join(root, "escape"));
  commit();
  assert.throws(() => prepareSnapshot(root, output), /Symlink escapes/u);
});

test("rejects symlink chains whose resolved target escapes the snapshot", (t) => {
  const { root, output, commit } = fixture(t);
  writeFileSync(nodePath.join(output, "outside"), "must not be scanned");
  symlinkSync(".", nodePath.join(root, "alias"));
  symlinkSync("alias/../outside", nodePath.join(root, "escape"));
  commit();
  assert.throws(() => prepareSnapshot(root, output), /Symlink escapes/u);
});

test("rejects dangling symlinks", (t) => {
  const { root, output, commit } = fixture(t);
  symlinkSync("missing", nodePath.join(root, "dangling"));
  commit();
  assert.throws(
    () => prepareSnapshot(root, output),
    /Unresolvable snapshot symlink/u
  );
});

test("rejects export-ignore omissions", (t) => {
  const { root, output, commit } = fixture(t);
  writeFileSync(
    nodePath.join(root, ".gitattributes"),
    "source.js export-ignore\n"
  );
  commit();
  assert.throws(() => prepareSnapshot(root, output), /Archive differs/u);
});

test("entry-point matchers cover their examples without flagging empty files", () => {
  for (const matcher of launchMatchers.matchers) {
    for (const example of matcher.examples) {
      assert.equal(matcher.match(example).length, 1);
    }

    assert.deepEqual(matcher.match(""), []);
  }
});

test("rejects archive content substitutions", (t) => {
  const { root, output, commit } = fixture(t);
  writeFileSync(
    nodePath.join(root, ".gitattributes"),
    "source.js export-subst\n"
  );
  writeFileSync(nodePath.join(root, "source.js"), "// $Format:%H$\n");
  commit();
  assert.throws(
    () => prepareSnapshot(root, output),
    /Snapshot content mismatch/u
  );
});

test("rejects unresolved Git LFS pointers", (t) => {
  const { root, output, commit } = fixture(t);
  writeFileSync(
    nodePath.join(root, "asset.bin"),
    "version https://git-lfs.github.com/spec/v1\n"
  );
  commit();
  assert.throws(
    () => prepareSnapshot(root, output),
    /Git LFS content needs separate review/u
  );
});
