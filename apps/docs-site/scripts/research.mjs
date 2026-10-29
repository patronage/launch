#!/usr/bin/env node
// Publish the repo's research notes (docs/spikes/*.md) as the site's Research
// section, so the notes stay the single source and the site never drifts from
// them. The generated pages are gitignored; `dev` and `build` run this first.
//
//   node scripts/research.mjs
//
// Each note's H1 becomes the page title (without its "Spike N:" prefix), and
// links are rewritten for the site: a link to another note points at its page,
// and a link into the repo (../../apps/payload) points at GitHub.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { root } from "./worker-config.mjs";

const repoRoot = path.resolve(root, "../..");
const notesDir = path.join(repoRoot, "docs/spikes");
const outDir = path.join(root, "docs/research");
const githubTree = "https://github.com/patronage/launch/tree/main";

// A note named after its issue (05-payload-on-vinext.md) publishes at
// /research/payload-on-vinext: Blume drops the numeric prefix from the URL and
// keeps it for ordering.
const route = (file) =>
  `/research/${path.basename(file, ".md").replace(/^\d+-/u, "")}`;

const rewriteLink = (target) => {
  if (/^[a-z]+:|^#|^\//u.test(target)) {
    return target;
  }

  const [file = "", hash] = target.split("#");
  const resolved = path.resolve(notesDir, file);

  if (path.dirname(resolved) === notesDir && file.endsWith(".md")) {
    return route(file) + (hash ? `#${hash}` : "");
  }

  return `${githubTree}/${path.relative(repoRoot, resolved)}${hash ? `#${hash}` : ""}`;
};

const toPage = (source) => {
  const [first = "", ...rest] = source.split("\n");
  const title = first.replace(/^#\s+/u, "").replace(/^Spike \d+:\s*/u, "");

  const body = rest
    .join("\n")
    .replaceAll(
      /\]\((?<target>[^)\s]+)\)/gu,
      (_, target) => `](${rewriteLink(target)})`
    )
    .trim();

  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}\n`;
};

mkdirSync(outDir, { recursive: true });

for (const file of readdirSync(outDir)) {
  if (/^\d+-.*\.md$/u.test(file)) {
    rmSync(path.join(outDir, file));
  }
}

const notes = readdirSync(notesDir).filter((file) =>
  /^\d+-.*\.md$/u.test(file)
);

for (const file of notes) {
  writeFileSync(
    path.join(outDir, file),
    toPage(readFileSync(path.join(notesDir, file), "utf-8"))
  );
}

console.log(`Published ${notes.length} research notes to docs/research/`);
