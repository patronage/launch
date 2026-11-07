#!/usr/bin/env node
// Releases the WordPress packages in wordpress-shared/ through the Composer
// repository at https://launch.patronage.com/composer, so a site can run
// `composer require patronage/launch-access`.
//
//   pnpm wp:release <folder>                # in the PR: add the folder's version to packages.json
//   pnpm wp:release --check                 # pnpm test: every package matches packages.json
//   pnpm wp:release --publish [--dry-run]   # after merge: create the GitHub releases that hold the zips
//
// <folder> is the package's folder in wordpress-shared/, such as patronage-access.
// Its version is the `Version:` header of <folder>/<folder>.php, or of the file
// that composer.json's extra.launch-version-file names, for a package that is
// not a plugin (wp-deploy).
//
// The docs site serves packages.json, and each version's download URL there
// (launch.patronage.com/composer/dist/<name>/<version>.zip) redirects to a zip
// attached to the GitHub release <name>-v<version> on patronage/launch. The zip
// is built the same way every time, so packages.json can carry its checksum
// before the release exists, and --check can prove the code still matches it.
// A zip holds the folder's files, minus the paths its .gitattributes marks
// export-ignore, plus the repo's LICENSE.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";

import { z } from "zod";

export const COMPOSER_URL = "https://launch.patronage.com/composer";
export const GITHUB_REPO = "patronage/launch";

const PACKAGE_TYPES = new Set([
  "library",
  "wordpress-muplugin",
  "wordpress-plugin",
]);

// The composer.json fields a release copies into packages.json.
const METADATA_FIELDS = [
  "description",
  "type",
  "license",
  "homepage",
  "authors",
  "support",
  "require",
  "extra",
] as const;

const composerSchema = z
  .object({
    extra: z.record(z.string(), z.json()).optional(),
    name: z.string(),
    type: z.string(),
    version: z.string().optional(),
  })
  .catchall(z.json());

type Composer = z.infer<typeof composerSchema>;

const entrySchema = z
  .object({
    dist: z.object({
      shasum: z.string().regex(/^[0-9a-f]{40}$/u),
      type: z.literal("zip"),
      url: z.string(),
    }),
    name: z.string(),
    version: z.string(),
  })
  .catchall(z.json());

type Entry = z.infer<typeof entrySchema>;

const repositorySchema = z.object({
  packages: z.record(z.string(), z.record(z.string(), entrySchema)),
});

type Repository = z.infer<typeof repositorySchema>;

export class ReleaseError extends Error {
  override name = "ReleaseError";
}

const fail = (message: string): never => {
  throw new ReleaseError(message);
};

let rootDir: string | undefined;

const root = () => {
  rootDir ??= execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();

  return rootDir;
};

const run = (command: string, args: string[], input?: string) =>
  execFileSync(command, args, {
    cwd: root(),
    encoding: "utf-8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();

const git = (args: string[], input?: string) => run("git", args, input);

const docsDir = () => path.join(root(), "apps/docs-site");

const repositoryFile = () =>
  path.join(docsDir(), "public/composer/packages.json");

// Appended to the site's _redirects by apps/docs-site/scripts/build-output.mjs.
const redirectsFile = () => path.join(docsDir(), "composer-redirects.txt");

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
};

const readRepository = (): Repository => {
  if (!existsSync(repositoryFile())) {
    return { packages: {} };
  }

  const parsed = repositorySchema.safeParse(
    JSON.parse(readFileSync(repositoryFile(), "utf-8"))
  );

  if (!parsed.success) {
    return fail(
      `apps/docs-site/public/composer/packages.json is not a Composer repository this script wrote: ${z.prettifyError(parsed.error)}`
    );
  }

  return parsed.data;
};

const sortRepository = (repository: Repository): Repository => {
  const packages: Repository["packages"] = {};

  for (const name of Object.keys(repository.packages).toSorted()) {
    const versions = repository.packages[name] ?? {};
    const sorted: Record<string, Entry> = {};

    for (const version of Object.keys(versions).toSorted(compareVersions)) {
      const entry = versions[version];

      if (entry) {
        sorted[version] = entry;
      }
    }

    packages[name] = sorted;
  }

  return { packages };
};

const slugOf = (name: string) => name.replace(/^patronage\//u, "");

export const tagOf = (name: string, version: string) =>
  `${slugOf(name)}-v${version}`;

const assetOf = (name: string, version: string) =>
  `${slugOf(name)}-${version}.zip`;

const distUrl = (name: string, version: string) =>
  `${COMPOSER_URL}/dist/${slugOf(name)}/${version}.zip`;

export const assetUrl = (name: string, version: string) =>
  `https://github.com/${GITHUB_REPO}/releases/download/${tagOf(name, version)}/${assetOf(name, version)}`;

const redirectsFor = (repository: Repository) => {
  const lines = [
    "# Written by pnpm wp:release from public/composer/packages.json. Each Composer",
    "# download redirects to its zip on the package's GitHub release.",
  ];

  for (const [name, versions] of Object.entries(repository.packages)) {
    for (const version of Object.keys(versions)) {
      lines.push(
        `${new URL(distUrl(name, version)).pathname} ${assetUrl(name, version)} 302`
      );
    }
  }

  return `${lines.join("\n")}\n`;
};

const writeRepository = (repository: Repository) => {
  const sorted = sortRepository(repository);

  mkdirSync(path.dirname(repositoryFile()), { recursive: true });
  writeFileSync(repositoryFile(), `${JSON.stringify(sorted, null, 2)}\n`);
  writeFileSync(redirectsFile(), redirectsFor(sorted));
};

/** The folders in wordpress-shared/ that are Composer packages. */
const packageFolders = () =>
  readdirSync(path.join(root(), "wordpress-shared"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(
          path.join(root(), "wordpress-shared", entry.name, "composer.json")
        )
    )
    .map((entry) => entry.name)
    .toSorted();

interface Package {
  versionFile: string;
  folder: string;
  dir: string;
  name: string;
  version: string;
  composer: Composer;
}

const readComposer = (dir: string) => {
  const composerFile = path.join(root(), dir, "composer.json");

  if (!existsSync(composerFile)) {
    fail(`${dir}/composer.json does not exist`);
  }

  const parsed = composerSchema.safeParse(
    JSON.parse(readFileSync(composerFile, "utf-8"))
  );

  if (!parsed.success) {
    return fail(
      `${dir}/composer.json: ${z.prettifyError(parsed.error).replaceAll("\n", " ")}`
    );
  }

  return parsed.data;
};

// A file name in the package's folder, never a path out of it.
const versionFileSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** The file whose Version header is the package's version, inside its folder. */
const versionFile = (dir: string, folder: string, composer: Composer) => {
  const named = composer.extra?.["launch-version-file"];

  if (named === undefined) {
    return `${folder}.php`;
  }

  const parsed = versionFileSchema.safeParse(named);

  if (!parsed.success) {
    return fail(
      `${dir}/composer.json: extra.launch-version-file must name a file in the package's folder`
    );
  }

  return parsed.data;
};

const readVersion = (dir: string, file: string) => {
  const mainFile = path.join(root(), dir, file);

  if (!existsSync(mainFile)) {
    fail(`${dir}/${file} does not exist`);
  }

  const version =
    /^[ \t/*#@]*Version:[ \t]*(?<version>\S+)/mu.exec(
      readFileSync(mainFile, "utf-8")
    )?.groups?.version ?? "";

  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    fail(`${dir}/${file}: the Version header must be x.y.z, not "${version}"`);
  }

  return version;
};

const readPackage = (folder: string): Package => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(folder)) {
    fail(`${folder}: not a package folder name`);
  }

  const dir = `wordpress-shared/${folder}`;
  const composer = readComposer(dir);
  const file = versionFile(dir, folder, composer);

  if (!/^patronage\/launch-[a-z0-9][a-z0-9-]*$/u.test(composer.name)) {
    fail(
      `${dir}/composer.json: name must be patronage/launch-<name>, not "${composer.name}"`
    );
  }

  if (!PACKAGE_TYPES.has(composer.type)) {
    fail(
      `${dir}/composer.json: type ${composer.type} is not one this repository serves`
    );
  }

  if (composer.version !== undefined) {
    fail(
      `${dir}/composer.json: leave out version; it comes from the ${file} header`
    );
  }

  if (
    composer.type.startsWith("wordpress-") &&
    composer.extra?.["installer-name"] !== folder
  ) {
    fail(
      `${dir}/composer.json: extra.installer-name must be "${folder}", the folder WordPress loads`
    );
  }

  return {
    composer,
    dir,
    folder,
    name: composer.name,
    version: readVersion(dir, file),
    versionFile: file,
  };
};

// git archive skips a whole folder marked export-ignore, but check-attr on a
// file inside it doesn't report the folder's attribute, so packageFiles asks
// about every folder on the way down too.
const ancestors = (file: string) => {
  const parts = file.split("/");

  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

/**
 * The files a package's zip holds, as paths inside the zip: what git would
 * commit in the folder (tracked, or untracked and not ignored), minus
 * export-ignore paths, plus the repo's LICENSE.
 */
export const packageFiles = (pkg: Package) => {
  const listed = git([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    pkg.dir,
  ])
    .split("\0")
    .filter((file) => file !== "" && existsSync(path.join(root(), file)));

  const paths = [...new Set(listed.flatMap(ancestors))];

  const attributes = git(
    ["check-attr", "-z", "--stdin", "export-ignore"],
    `${paths.join("\0")}\0`
  ).split("\0");

  const ignored = new Set<string>();

  // check-attr -z prints <path> NUL <attribute> NUL <value> NUL for each path.
  for (let i = 0; i + 2 < attributes.length; i += 3) {
    const file = attributes[i];

    if (file !== undefined && attributes[i + 2] === "set") {
      ignored.add(file);
    }
  }

  const files = listed
    .filter((file) => !ancestors(file).some((part) => ignored.has(part)))
    .map((file) => ({ name: path.posix.relative(pkg.dir, file), source: file }))
    .filter((file) => file.name !== "LICENSE");

  files.push({ name: "LICENSE", source: "LICENSE" });

  return files.toSorted((a, b) => (a.name < b.name ? -1 : 1));
};

// Zip header values. The date is 1980-01-01 at midnight, the earliest a zip
// can hold, as a DOS date: (year - 1980) << 9 | month << 5 | day.
const ZIP_VERSION = 20;
const ZIP_UTF8_NAMES = 0x08_00;
const ZIP_STORED = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 33;

// Made by Unix (3 << 8), zip version 2.0.
const ZIP_MADE_BY_UNIX = 788;

// A regular file, -rw-r--r--: 0o100644 << 16.
const ZIP_FILE_MODE = 0x81_a4_00_00;

/**
 * A stored (uncompressed) zip with fixed timestamps and modes, so the same
 * files always make the same bytes, whatever machine builds it.
 */
export const buildZip = (files: { name: string; data: Buffer }[]) => {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf-8");
    const crc = crc32(file.data);
    const size = file.data.length;
    const header = Buffer.alloc(30);

    header.writeUInt32LE(0x04_03_4b_50, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_UTF8_NAMES, 6);
    header.writeUInt16LE(ZIP_STORED, 8);
    header.writeUInt16LE(ZIP_DOS_TIME, 10);
    header.writeUInt16LE(ZIP_DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, file.data);

    const entry = Buffer.alloc(46);

    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(ZIP_MADE_BY_UNIX, 4);
    entry.writeUInt16LE(ZIP_VERSION, 6);
    entry.writeUInt16LE(ZIP_UTF8_NAMES, 8);
    entry.writeUInt16LE(ZIP_STORED, 10);
    entry.writeUInt16LE(ZIP_DOS_TIME, 12);
    entry.writeUInt16LE(ZIP_DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(ZIP_FILE_MODE, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, ...central, end]);
};

const packageZip = (pkg: Package) =>
  buildZip(
    packageFiles(pkg).map((file) => ({
      data: readFileSync(path.join(root(), file.source)),
      name: file.name,
    }))
  );

/** A package folder's zip, as a release builds it. */
export const zipFor = (folder: string) => packageZip(readPackage(folder));

const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("hex");

const entryFor = (pkg: Package, shasum: string): Entry => {
  const entry: Entry = {
    dist: { shasum, type: "zip", url: distUrl(pkg.name, pkg.version) },
    name: pkg.name,
    version: pkg.version,
  };

  for (const field of METADATA_FIELDS) {
    const value = pkg.composer[field];

    if (value !== undefined) {
      entry[field] = value;
    }
  }

  return entry;
};

/** Adds a package's current version to packages.json. */
export const release = (folder: string) => {
  const pkg = readPackage(folder);
  const repository = readRepository();
  const versions = repository.packages[pkg.name] ?? {};

  if (versions[pkg.version]) {
    fail(
      `${pkg.name} ${pkg.version} is already released; bump the Version header in ${pkg.dir}/${pkg.versionFile}`
    );
  }

  const latest = Object.keys(versions).toSorted(compareVersions).at(-1);

  if (latest && compareVersions(pkg.version, latest) <= 0) {
    fail(`${pkg.name} ${pkg.version} is not newer than the released ${latest}`);
  }

  const files = packageFiles(pkg);

  versions[pkg.version] = entryFor(pkg, sha1(packageZip(pkg)));
  repository.packages[pkg.name] = versions;
  writeRepository(repository);

  return {
    files: files.map((file) => file.name),
    name: pkg.name,
    version: pkg.version,
  };
};

/** Problems with packages.json and the redirects written from it. */
const checkRepository = (repository: Repository) => {
  const problems: string[] = [];

  for (const [name, versions] of Object.entries(repository.packages)) {
    for (const [version, entry] of Object.entries(versions)) {
      if (entry.name !== name || entry.version !== version) {
        problems.push(
          `packages.json: ${name} ${version} names itself ${entry.name} ${entry.version}`
        );
      }

      if (entry.dist.url !== distUrl(name, version)) {
        problems.push(
          `packages.json: ${name} ${version} should download ${distUrl(name, version)}`
        );
      }
    }
  }

  if (
    JSON.stringify(sortRepository(repository)) !== JSON.stringify(repository)
  ) {
    problems.push(
      "packages.json is not in order: run pnpm wp:release on a package, or sort it by hand"
    );
  }

  const redirects = existsSync(redirectsFile())
    ? readFileSync(redirectsFile(), "utf-8")
    : "";

  if (redirects !== redirectsFor(sortRepository(repository))) {
    problems.push(
      "apps/docs-site/composer-redirects.txt does not match packages.json; pnpm wp:release writes both"
    );
  }

  return problems;
};

/** Problems with one package folder against its released version. */
const checkPackage = (folder: string, repository: Repository) => {
  let pkg: Package;

  try {
    pkg = readPackage(folder);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const entry = repository.packages[pkg.name]?.[pkg.version];
  const how = `bump the Version header in ${pkg.dir}/${pkg.versionFile} and run pnpm wp:release ${folder}`;

  if (!entry) {
    return [
      `${pkg.name} ${pkg.version} is not in packages.json: run pnpm wp:release ${folder}`,
    ];
  }

  const problems: string[] = [];

  for (const field of METADATA_FIELDS) {
    if (JSON.stringify(entry[field]) !== JSON.stringify(pkg.composer[field])) {
      problems.push(
        `${pkg.name}: composer.json's ${field} changed since ${pkg.version} was released: ${how}`
      );
    }
  }

  if (entry.dist.shasum !== sha1(packageZip(pkg))) {
    problems.push(
      `${pkg.name}: files changed since ${pkg.version} was released: ${how}`
    );
  }

  return problems;
};

/** Problems with packages.json, or packages that changed without a release. */
export const check = () => {
  let repository: Repository;

  try {
    repository = readRepository();
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  return [
    ...checkRepository(repository),
    ...packageFolders().flatMap((folder) => checkPackage(folder, repository)),
  ];
};

const releaseExists = (tag: string) => {
  try {
    run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      GITHUB_REPO,
      "--json",
      "tagName",
    ]);

    return true;
  } catch {
    return false;
  }
};

const createRelease = (pkg: Package, zip: Buffer, head: string) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "launch-release-"));

  try {
    const file = path.join(tmp, assetOf(pkg.name, pkg.version));

    writeFileSync(file, zip);
    run("gh", [
      "release",
      "create",
      tagOf(pkg.name, pkg.version),
      file,
      "--repo",
      GITHUB_REPO,
      "--target",
      head,
      "--title",
      `${pkg.name} ${pkg.version}`,
      "--notes",
      `Install with Composer from ${COMPOSER_URL}: composer require ${pkg.name}:${pkg.version}. Source: ${pkg.dir} at ${head.slice(0, 12)}.`,
      "--latest=false",
    ]);
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
};

/** Creates the GitHub release, with its zip, for each current version that lacks one. */
export const publish = ({ dryRun }: { dryRun: boolean }) => {
  const problems = check();

  if (problems.length > 0) {
    fail(`fix these first:\n  ${problems.join("\n  ")}`);
  }

  if (git(["status", "--porcelain"]) !== "") {
    fail("the working tree has uncommitted changes");
  }

  git(["fetch", "--quiet", "origin", "main"]);
  const head = git(["rev-parse", "HEAD"]);

  if (head !== git(["rev-parse", "FETCH_HEAD"])) {
    fail("HEAD is not origin/main: publish after the release PR merges");
  }

  const repository = readRepository();
  const published: string[] = [];

  for (const folder of packageFolders()) {
    const pkg = readPackage(folder);
    const tag = tagOf(pkg.name, pkg.version);

    if (releaseExists(tag)) {
      continue;
    }

    const zip = packageZip(pkg);

    if (
      sha1(zip) !== repository.packages[pkg.name]?.[pkg.version]?.dist.shasum
    ) {
      fail(`${pkg.name} ${pkg.version}: the zip does not match packages.json`);
    }

    published.push(tag);

    if (!dryRun) {
      createRelease(pkg, zip, head);
    }
  }

  return published;
};

const main = (args: string[]) => {
  if (args[0] === "--check" && args.length === 1) {
    const problems = check();

    for (const problem of problems) {
      console.error(`wp:release: ${problem}`);
    }

    if (problems.length > 0) {
      process.exit(1);
    }

    console.log(
      `wp:release: ${packageFolders().length} packages match packages.json`
    );

    return;
  }

  if (args[0] === "--publish") {
    const dryRun = args.includes("--dry-run");
    const tags = publish({ dryRun });

    console.log(
      tags.length === 0
        ? "wp:release: every current version already has its GitHub release"
        : `wp:release: ${dryRun ? "would create" : "created"} ${tags.join(", ")}`
    );

    return;
  }

  const [folder] = args;

  if (args.length !== 1 || folder === undefined || folder.startsWith("-")) {
    console.error(
      "usage: pnpm wp:release <folder> | --check | --publish [--dry-run]"
    );
    process.exit(2);
  }

  const result = release(folder);

  console.log(
    `wp:release: added ${result.name} ${result.version} to packages.json, with:`
  );

  for (const file of result.files) {
    console.log(`  ${file}`);
  }

  console.log(
    "wp:release: commit it with the change; after merge, run pnpm wp:release --publish."
  );
};

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`wp:release: ${error.message}`);
      process.exit(1);
    }

    throw error;
  }
}
