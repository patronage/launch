// `pnpm release:check`: a branch that changes a published package needs a
// changeset. The one exception is the release-prep branch itself, where
// `changeset version` has consumed the changesets (deleting them) and written
// the versions and changelogs, so there is nothing left to describe.
import { execFileSync } from "node:child_process";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf-8" }).trim();

const consumed = git(
  "diff",
  "--diff-filter=D",
  "--name-only",
  "origin/main...HEAD",
  "--",
  ".changeset/*.md"
)
  .split("\n")
  .filter((file) => file && !file.endsWith("README.md"));

if (consumed.length > 0) {
  console.log(
    `release:check: ${consumed.length} changeset(s) consumed by changeset version; nothing to add.`
  );
  process.exit(0);
}

execFileSync("pnpm", ["exec", "changeset", "status", "--since=origin/main"], {
  stdio: "inherit",
});
