// Runs pnpm wp:release against a throwaway repository shaped like Launch.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it } from "vitest";

import { buildZip } from "../release.ts";

const script = path.join(import.meta.dirname, "..", "release.ts");
let repo = "";

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

const sh = (command: string, args: string[]) =>
  execFileSync(command, args, { cwd: repo, encoding: "utf-8" });

const release = (...args: string[]) => {
  const result = spawnSync("node", [script, ...args], {
    cwd: repo,
    encoding: "utf-8",
  });

  return { output: `${result.stdout}${result.stderr}`, status: result.status };
};

const packages = () =>
  // SAFETY: the release under test wrote this file; a wrong shape fails the
  // assertions that read it.
  JSON.parse(
    readFileSync(
      path.join(repo, "apps/docs-site/public/composer/packages.json"),
      "utf-8"
    )
  ) as {
    packages: Record<
      string,
      Record<string, { dist: { shasum: string; url: string } }>
    >;
  };

const plugin = (version: string, body = "echo 1;") =>
  write(
    "wordpress-shared/patronage-demo/patronage-demo.php",
    `<?php\n/**\n * Plugin Name: Demo\n * Version: ${version}\n */\n${body}\n`
  );

describe("pnpm wp:release", () => {
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "launch-release-test-"));
    sh("git", ["init", "--quiet"]);
    write("LICENSE", "MIT\n");
    write(".gitignore", "build/\n");
    write(
      "wordpress-shared/patronage-demo/composer.json",
      `${JSON.stringify(
        {
          description: "A demo.",
          extra: { "installer-name": "patronage-demo" },
          license: "MIT",
          name: "patronage/launch-demo",
          require: { "composer/installers": "^2.2", php: ">=8.1" },
          type: "wordpress-muplugin",
        },
        null,
        2
      )}\n`
    );
    write(
      "wordpress-shared/patronage-demo/.gitattributes",
      "/README.md export-ignore\n/tests export-ignore\n/composer.json export-ignore\n/.gitattributes export-ignore\n"
    );
    write("wordpress-shared/patronage-demo/README.md", "# Demo\n");
    write("wordpress-shared/patronage-demo/tests/a.test.php", "<?php\n");
    write("wordpress-shared/patronage-demo/inc/helpers.php", "<?php\n");
    write("wordpress-shared/patronage-demo/build/ignored.txt", "gitignored\n");
    write("wordpress-shared/no-composer/readme.txt", "not a package\n");
    plugin("1.0.0");
  });

  afterEach(() => {
    rmSync(repo, { force: true, recursive: true });
  });

  it("a package that was never released fails the check", () => {
    const result = release("--check");
    assert.equal(result.status, 1);
    assert.match(
      result.output,
      /patronage\/launch-demo 1\.0\.0 is not in packages\.json/u
    );
  });

  it("a library takes its version from the file extra.launch-version-file names", () => {
    write(
      "wordpress-shared/demo-kit/composer.json",
      `${JSON.stringify(
        {
          description: "A kit.",
          extra: { "launch-version-file": "kit.sh" },
          license: "MIT",
          name: "patronage/launch-demo-kit",
          type: "library",
        },
        null,
        2
      )}\n`
    );
    write(
      "wordpress-shared/demo-kit/kit.sh",
      "#!/bin/sh\n# Version: 3.1.0\necho kit\n"
    );
    const result = release("demo-kit");
    assert.equal(result.status, 0, result.output);
    assert.ok(packages().packages["patronage/launch-demo-kit"]?.["3.1.0"]);
    write(
      "wordpress-shared/demo-kit/kit.sh",
      "#!/bin/sh\n# Version: 3.1.0\necho changed\n"
    );
    assert.match(
      release("--check").output,
      /bump the Version header in wordpress-shared\/demo-kit\/kit\.sh/u
    );
  });

  it("extra.launch-version-file must be a file in the package's folder", () => {
    write(
      "wordpress-shared/demo-kit/composer.json",
      `${JSON.stringify({ extra: { "launch-version-file": "../x.sh" }, name: "patronage/launch-demo-kit", type: "library" })}\n`
    );
    const result = release("demo-kit");
    assert.equal(result.status, 1);
    assert.match(result.output, /must name a file in the package's folder/u);
  });

  it("a release writes packages.json and the redirects, and then the check passes", () => {
    const result = release("patronage-demo");
    assert.equal(result.status, 0, result.output);
    assert.match(
      result.output,
      /LICENSE\n {2}inc\/helpers\.php\n {2}patronage-demo\.php\n/u
    );
    assert.doesNotMatch(result.output, /README|tests|composer\.json|ignored/u);
    const entry = packages().packages["patronage/launch-demo"]?.["1.0.0"];
    assert.equal(
      entry?.dist.url,
      "https://launch.patronage.com/composer/dist/launch-demo/1.0.0.zip"
    );
    assert.match(entry?.dist.shasum ?? "", /^[0-9a-f]{40}$/u);
    assert.equal(
      readFileSync(
        path.join(repo, "apps/docs-site/composer-redirects.txt"),
        "utf-8"
      )
        .split("\n")
        .at(-2),
      "/composer/dist/launch-demo/1.0.0.zip https://github.com/patronage/launch/releases/download/launch-demo-v1.0.0/launch-demo-1.0.0.zip 302"
    );
    assert.equal(release("--check").status, 0);
  });

  it("changing a shipped file needs a new version; changing an export-ignored one doesn't", () => {
    release("patronage-demo");
    write("wordpress-shared/patronage-demo/README.md", "# Demo, reworded\n");
    write("wordpress-shared/patronage-demo/tests/b.test.php", "<?php\n");
    assert.equal(release("--check").status, 0);

    write(
      "wordpress-shared/patronage-demo/inc/helpers.php",
      "<?php\n// changed\n"
    );
    const changed = release("--check");
    assert.equal(changed.status, 1);
    assert.match(changed.output, /files changed since 1\.0\.0 was released/u);
    assert.match(
      release("patronage-demo").output,
      /1\.0\.0 is already released/u
    );

    plugin("1.1.0");
    assert.equal(release("patronage-demo").status, 0);
    assert.equal(release("--check").status, 0);
    assert.deepEqual(
      Object.keys(packages().packages["patronage/launch-demo"] ?? {}),
      ["1.0.0", "1.1.0"]
    );
  });

  it("composer.json metadata is part of a release", () => {
    release("patronage-demo");

    const file = path.join(
      repo,
      "wordpress-shared/patronage-demo/composer.json"
    );

    writeFileSync(
      file,
      readFileSync(file, "utf-8").replace('"php": ">=8.1"', '"php": ">=8.2"')
    );
    assert.match(
      release("--check").output,
      /composer\.json's require changed since 1\.0\.0/u
    );
  });

  it("versions only go up, and names and folders must line up", () => {
    plugin("2.0.0");
    release("patronage-demo");
    plugin("1.9.0");
    assert.match(
      release("patronage-demo").output,
      /1\.9\.0 is not newer than the released 2\.0\.0/u
    );

    const file = path.join(
      repo,
      "wordpress-shared/patronage-demo/composer.json"
    );

    writeFileSync(
      file,
      readFileSync(file, "utf-8").replace(
        '"installer-name": "patronage-demo"',
        '"installer-name": "demo"'
      )
    );
    assert.match(
      release("--check").output,
      /extra\.installer-name must be "patronage-demo"/u
    );
  });

  it("the zip is the same bytes every time, and unzip reads it", () => {
    const files = [
      { data: Buffer.from("<?php\necho 'hi';\n"), name: "patronage-demo.php" },
      { data: Buffer.from("MIT\n"), name: "LICENSE" },
      { data: Buffer.from(""), name: "inc/empty.php" },
    ];

    const zip = buildZip(files);
    assert.deepEqual(buildZip(files), zip);
    writeFileSync(path.join(repo, "demo.zip"), zip);
    assert.match(sh("unzip", ["-t", "demo.zip"]), /No errors detected/u);
    assert.equal(
      sh("unzip", ["-p", "demo.zip", "patronage-demo.php"]),
      "<?php\necho 'hi';\n"
    );
  });
});
