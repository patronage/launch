#!/usr/bin/env node
// Publish the repo's research notes (docs/spikes/*.md) as the site's Research
// section (docs/research/), so the notes stay the single source and the site
// never drifts from them. The decision records in docs/adr/ are engineering
// docs and stay in the repo; links to them point at GitHub.
//
// The generated pages are gitignored; `dev`, `build` and `test` run this first.
//
//   node scripts/publish-notes.mjs
//
// Each note's H1 becomes the page title (a spike's "Spike N:" prefix is
// dropped), notes keep their file-name order in the sidebar, and links are
// rewritten for the site: a link to another note points at its page, a link
// to the notes folder points at the section, and a link into the repo
// (../adr/0011-cms-behind-cloudflare-access.md) points at GitHub.
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

      // A section's README becomes its overview page, which doesn't carry
      // the README's headings, so an anchored link goes to GitHub instead.
      if (name === "README.md" && !hash) {
        return section.route;
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
