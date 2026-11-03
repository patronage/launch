#!/usr/bin/env node
// Publish the repo's engineering notes as site sections, so the notes stay the
// single source and the site never drifts from them:
//
//   docs/spikes/*.md  ->  Research   (docs/research/)
//   docs/adr/*.md     ->  Decisions  (docs/decisions/)
//
// The generated pages are gitignored; `dev`, `build` and `test` run this first.
//
//   node scripts/publish-notes.mjs
//
// Each note's H1 becomes the page title (a spike's "Spike N:" prefix is
// dropped), notes keep their file-name order in the sidebar, and links are
// rewritten for the site: a link to another published note points at its
// page, a link to a published folder points at its section, and a link into
// the repo (../../apps/payload) points at GitHub.
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
const githubTree = "https://github.com/patronage/launch/tree/main";

const sections = [
  {
    label: "research notes",
    notesDir: path.join(repoRoot, "docs/spikes"),
    outDir: path.join(root, "docs/research"),
    route: "/research",
    title: (heading) => heading.replace(/^Spike(?: \d+)?:\s*/u, ""),
  },
  {
    label: "decision records",
    notesDir: path.join(repoRoot, "docs/adr"),
    outDir: path.join(root, "docs/decisions"),
    route: "/decisions",
    title: (heading) => heading,
  },
];

const isNote = (file) => /^\d+-.*\.md$/u.test(file);

// A note named after its number (05-payload-on-vinext.md) publishes at
// /research/payload-on-vinext: Blume drops the numeric prefix from the URL and
// keeps it for ordering.
const pageRoute = (section, file) =>
  `${section.route}/${path.basename(file, ".md").replace(/^\d+-/u, "")}`;

const rewriteLink = (from, target) => {
  if (/^[a-z]+:|^#|^\//u.test(target)) {
    return target;
  }

  const [file = "", hash] = target.split("#");
  const anchor = hash ? `#${hash}` : "";
  const resolved = path.resolve(from.notesDir, file);

  for (const section of sections) {
    if (resolved === section.notesDir) {
      return section.route + anchor;
    }

    if (path.dirname(resolved) === section.notesDir) {
      const name = path.basename(resolved);

      if (isNote(name)) {
        return pageRoute(section, name) + anchor;
      }

      if (name === "README.md") {
        return section.route + anchor;
      }
    }
  }

  return `${githubTree}/${path.relative(repoRoot, resolved)}${anchor}`;
};

const toPage = (section, source, order) => {
  const [first = "", ...rest] = source.split("\n");
  const title = section.title(first.replace(/^#\s+/u, ""));

  const body = rest
    .join("\n")
    .replaceAll(
      /\]\((?<target>[^)\s]+)\)/gu,
      (_, target) => `](${rewriteLink(section, target)})`
    )
    .trim();

  return `---\ntitle: ${JSON.stringify(title)}\nsidebar:\n  order: ${order}\n---\n\n${body}\n`;
};

for (const section of sections) {
  mkdirSync(section.outDir, { recursive: true });

  for (const file of readdirSync(section.outDir)) {
    if (isNote(file)) {
      rmSync(path.join(section.outDir, file));
    }
  }

  const notes = readdirSync(section.notesDir).filter(isNote).toSorted();

  for (const [index, file] of notes.entries()) {
    writeFileSync(
      path.join(section.outDir, file),
      toPage(
        section,
        readFileSync(path.join(section.notesDir, file), "utf-8"),
        index + 1
      )
    );
  }

  console.log(
    `Published ${notes.length} ${section.label} to ${path.relative(root, section.outDir)}/`
  );
}
