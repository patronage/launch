import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });

// Package export rules describe release zips, not the security-review boundary.
// Override them in a disposable bare repository that reads the same objects.
// Its info/attributes takes precedence over committed and global attributes;
// the live repository's attributes, index and working tree remain untouched.
const archiveCommit = (root, archive, commit, algorithm) => {
  const isolated = mkdtempSync(nodePath.join(tmpdir(), "launch-archive-"));

  try {
    git(isolated, ["init", "--bare", `--object-format=${algorithm}`]);

    const objects = git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim();

    writeFileSync(
      nodePath.join(isolated, "objects/info/alternates"),
      `${objects}\n`
    );
    writeFileSync(
      nodePath.join(isolated, "info/attributes"),
      "* -export-ignore -export-subst\n"
    );
    git(isolated, ["archive", "--format=tar", `--output=${archive}`, commit]);
  } finally {
    rmSync(isolated, { force: true, recursive: true });
  }
};

export const prepareSnapshot = (root, destination, revision = "HEAD") => {
  const commit = git(root, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]).trim();

  const algorithm = git(root, ["rev-parse", "--show-object-format"]).trim();

  const entries = git(root, ["ls-tree", "-rz", commit])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, hash] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);

      if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
        throw new Error(
          `Unsupported Git entry (submodules need separate review): ${path}`
        );
      }

      if (
        nodePath.isAbsolute(path) ||
        path.split("/").includes("..") ||
        /[\n\r]/u.test(path)
      ) {
        throw new Error(`Unsafe archive path: ${path}`);
      }

      if (
        /(?:^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|\.mcp\.json|credentials\.json|auth\.json|id_rsa|id_ed25519)$/u.test(
          path
        ) &&
        !path.endsWith(".example")
      ) {
        throw new Error(`Credential-bearing path requires review: ${path}`);
      }

      if (mode === "120000") {
        const target = git(root, ["cat-file", "blob", hash]);

        const resolved = nodePath.relative(
          root,
          nodePath.resolve(root, path, "..", target)
        );

        if (
          nodePath.isAbsolute(target) ||
          resolved === ".." ||
          resolved.startsWith("../")
        ) {
          throw new Error(`Symlink escapes the snapshot: ${path}`);
        }
      }

      return { hash, mode, path };
    });

  const archive = nodePath.join(destination, "source.tar");
  const source = nodePath.join(destination, "source");
  mkdirSync(source, { recursive: true });
  archiveCommit(root, archive, commit, algorithm);

  const archived = execFileSync("tar", ["-tf", archive], { encoding: "utf-8" })
    .split("\n")
    .filter((path) => path && !path.endsWith("/"));

  const expected = entries.map(({ path }) => path).toSorted();

  if (JSON.stringify(archived.toSorted()) !== JSON.stringify(expected)) {
    throw new Error("Archive differs from the committed manifest.");
  }

  execFileSync("tar", ["-xf", archive, "-C", source]);

  // Compare extracted bytes too: the snapshot must contain exact Git blobs.
  for (const entry of entries) {
    const path = nodePath.join(source, entry.path);
    const stat = lstatSync(path);

    const bytes =
      entry.mode === "120000"
        ? Buffer.from(readlinkSync(path))
        : readFileSync(path);

    const hash = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");

    if (
      hash !== entry.hash ||
      stat.isSymbolicLink() !== (entry.mode === "120000")
    ) {
      throw new Error(`Snapshot content mismatch: ${entry.path}`);
    }

    if (stat.isSymbolicLink()) {
      let resolved;

      try {
        // Native resolution preserves filesystem semantics for symlink/.. chains.
        resolved = nodePath.relative(
          realpathSync.native(source),
          realpathSync.native(path)
        );
      } catch {
        throw new Error(`Unresolvable snapshot symlink: ${entry.path}`);
      }

      if (resolved === ".." || resolved.startsWith(`..${nodePath.sep}`)) {
        throw new Error(
          `Symlink escapes the snapshot through another link: ${entry.path}`
        );
      }
    }

    if (
      bytes
        .subarray(0, 100)
        .toString()
        .startsWith("version https://git-lfs.github.com/spec/v1")
    ) {
      throw new Error(`Git LFS content needs separate review: ${entry.path}`);
    }
  }

  // Never follow symlinks when enumerating the extracted tree.
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = nodePath.join(directory, entry.name);

      return entry.isDirectory()
        ? walk(path)
        : [nodePath.relative(source, path)];
    });

  if (JSON.stringify(walk(source).toSorted()) !== JSON.stringify(expected)) {
    throw new Error("Extracted snapshot has unexpected files.");
  }

  const manifest = { algorithm, commit, files: entries };
  writeFileSync(
    nodePath.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  return manifest;
};
