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

const githubTree = "https://github.com/patronage/launch/tree/main";

// The site folder, and the repo it sits in two levels down.
const defaultSiteRoot = path.resolve(import.meta.dirname, "..");

const sectionsFor = (repoRoot, siteRoot) => [
  {
    label: "research notes",
    notesDir: path.join(repoRoot, "docs/spikes"),
    outDir: path.join(siteRoot, "docs/research"),
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

const rewriteLink = (repoRoot, sections, from, target) => {
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

const toPage = (repoRoot, sections, section, source, order) => {
  const [first = "", ...rest] = source.split("\n");
  const title = section.title(first.replace(/^#\s+/u, ""));

  const body = rest
    .join("\n")
    .replaceAll(
      /\]\((?<target>[^)\s]+)\)/gu,
      (_, target) => `](${rewriteLink(repoRoot, sections, section, target)})`
    )
    .trim();

  return `---\ntitle: ${JSON.stringify(title)}\nsidebar:\n  order: ${order}\n---\n\n${body}\n`;
};

/**
 * Publish every section's notes from `repoRoot` into `siteRoot`. Tests pass
 * temp folders; the script itself uses this repo and this site.
 */
export const publishNotes = ({
  siteRoot = defaultSiteRoot,
  repoRoot = path.resolve(siteRoot, "../.."),
  log = console.log,
} = {}) => {
  const sections = sectionsFor(repoRoot, siteRoot);

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
          repoRoot,
          sections,
          section,
          readFileSync(path.join(section.notesDir, file), "utf-8"),
          index + 1
        )
      );
    }

    log(
      `Published ${notes.length} ${section.label} to ${path.relative(siteRoot, section.outDir)}/`
    );
  }
};

if (process.argv[1] === import.meta.filename) {
  publishNotes();
}
