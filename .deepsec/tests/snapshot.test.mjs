// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
// The scanner tests deliberately have no app or test-runner dependencies.
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

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

test("includes nested export-ignore files and directories without changing local attributes", (t) => {
  const { root, output, commit } = fixture(t);
  const pkg = nodePath.join(root, "wordpress-shared/patronage-demo");
  mkdirSync(nodePath.join(pkg, "tests"), { recursive: true });
  writeFileSync(nodePath.join(pkg, "composer.json"), '{"name":"demo"}\n');
  writeFileSync(nodePath.join(pkg, "tests/check.php"), "<?php\n");
  writeFileSync(
    nodePath.join(pkg, ".gitattributes"),
    "/composer.json export-ignore\n/tests export-ignore\n"
  );
  writeFileSync(
    nodePath.join(root, ".gitattributes"),
    "source.js export-ignore\n"
  );
  commit();
  const localAttributes = "wordpress-shared export-ignore\n";
  const localFile = nodePath.join(root, ".git/info/attributes");
  writeFileSync(localFile, localAttributes);
  const manifest = prepareSnapshot(root, output);
  assert.equal(manifest.files.length, 5);
  assert.equal(
    readFileSync(
      nodePath.join(
        output,
        "source/wordpress-shared/patronage-demo/composer.json"
      ),
      "utf-8"
    ),
    '{"name":"demo"}\n'
  );
  assert.equal(readFileSync(localFile, "utf-8"), localAttributes);
});

test("preserves exact committed bytes instead of export-subst replacements", (t) => {
  const { root, output, commit } = fixture(t);
  writeFileSync(
    nodePath.join(root, ".gitattributes"),
    "source.js export-subst\n"
  );
  writeFileSync(nodePath.join(root, "source.js"), "// $Format:%H$\n");
  commit();
  prepareSnapshot(root, output);
  assert.equal(
    readFileSync(nodePath.join(output, "source/source.js"), "utf-8"),
    "// $Format:%H$\n"
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
