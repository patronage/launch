// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// Publishes notes from a fake repo in a temp folder, never into this site.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import { publishNotes } from "./publish-notes.mjs";

const tree = "https://github.com/patronage/launch/tree/main";

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const FIRST_NOTE = [
  "# Spike 2: First note",
  "",
  "See [the second](./10-second-note.md#setup), [all notes](./),",
  "[the overview](README.md), [an anchored overview](README.md#list),",
  "[a decision](../adr/0001-demo.md), [a page](https://example.org/x),",
  "[a heading](#intro) and [a site page](/deploy).",
  "",
].join("\n");

/** A repo in a temp folder with two notes, published into its own site folder. */
const publishFakeRepo = (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "publish-notes-"));
  t.after(() => rmSync(repo, { force: true, recursive: true }));

  const site = path.join(repo, "apps", "docs-site");
  const research = path.join(site, "docs", "research");
  const spikes = path.join(repo, "docs", "spikes");

  write(path.join(spikes, "02-first-note.md"), FIRST_NOTE);
  write(
    path.join(spikes, "10-second-note.md"),
    "# Spike: Second note\n\nBody.\n"
  );
  write(path.join(spikes, "README.md"), "# Notes\n");
  write(path.join(spikes, "draft.md"), "# Draft\n");
  write(path.join(repo, "docs", "adr", "0001-demo.md"), "# ADR\n");
  // A page the site keeps, and a note that no longer exists in the repo.
  write(path.join(research, "index.mdx"), "kept\n");
  write(path.join(research, "01-removed-note.md"), "stale\n");

  const logs = [];
  publishNotes({ log: (line) => logs.push(line), siteRoot: site });

  const page = (file) => readFileSync(path.join(research, file), "utf-8");

  return { logs, page, research };
};

test("publishes only the numbered notes in docs/spikes, replacing stale ones", (t) => {
  const { logs, page, research } = publishFakeRepo(t);

  assert.deepEqual(readdirSync(research).toSorted(), [
    "02-first-note.md",
    "10-second-note.md",
    "index.mdx",
  ]);
  assert.equal(page("index.mdx"), "kept\n");
  assert.deepEqual(logs, ["Published 2 research notes to docs/research/"]);
});

test("turns the heading into a title without the Spike prefix and orders notes by file name", (t) => {
  const { page } = publishFakeRepo(t);

  assert.match(
    page("02-first-note.md"),
    /^---\ntitle: "First note"\nsidebar:\n {2}order: 1\n---\n\nSee /u
  );
  assert.equal(
    page("10-second-note.md"),
    '---\ntitle: "Second note"\nsidebar:\n  order: 2\n---\n\nBody.\n'
  );
});

test("rewrites links to notes, the notes folder and the repo for the site", (t) => {
  const first = publishFakeRepo(t).page("02-first-note.md");

  assert.ok(first.includes("[the second](/research/second-note#setup)"));
  assert.ok(first.includes("[all notes](/research)"));
  assert.ok(first.includes("[the overview](/research)"));
  assert.ok(
    first.includes(`[an anchored overview](${tree}/docs/spikes/README.md#list)`)
  );
  assert.ok(first.includes(`[a decision](${tree}/docs/adr/0001-demo.md)`));
});

test("leaves absolute, anchor and site links alone", (t) => {
  const first = publishFakeRepo(t).page("02-first-note.md");

  assert.ok(first.includes("[a page](https://example.org/x)"));
  assert.ok(first.includes("[a heading](#intro)"));
  assert.ok(first.includes("[a site page](/deploy)"));
});
