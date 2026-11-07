// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import { prepareReviewContext } from "../scripts/context.mjs";

test("supplies DeepSec's on-disk context contract without replacing analysis records", (t) => {
  const run = mkdtempSync(path.join(tmpdir(), "launch-review-context-"));
  t.after(() => rmSync(run, { force: true, recursive: true }));
  const directory = path.join(run, "data", "launch");
  mkdirSync(path.join(directory, "files"), { recursive: true });
  writeFileSync(
    path.join(directory, "files", "existing.json"),
    "existing result"
  );
  writeFileSync(path.join(directory, "INFO.md"), "stale context");
  writeFileSync(
    path.join(directory, "config.json"),
    '{"promptAppend":"stale instructions"}'
  );

  prepareReviewContext(run);

  assert.equal(
    readFileSync(path.join(directory, "INFO.md"), "utf-8"),
    readFileSync(new URL("../INFO.md", import.meta.url), "utf-8")
  );

  const config = JSON.parse(
    readFileSync(path.join(directory, "config.json"), "utf-8")
  );

  assert.ok(
    config.priorityPaths.includes("wordpress-shared/patronage-access/")
  );

  for (const target of [
    "wordpress-shared/patronage-fleet/",
    "wordpress-shared/patronage-headless-revalidate/",
    "wordpress-shared/patronage-logging/",
    "wordpress-shared/plugin-release/",
    "apps/docs-site/public/composer/",
    "apps/docs-site/composer-redirects.txt",
    "apps/docs-site/scripts/build-output.mjs",
    "apps/cms-wordpress-headless/composer.json",
    "apps/cms-wordpress-headless/bin/build.sh",
    "apps/cms-wordpress-headless/_build/.deploy_include.txt",
  ]) {
    assert.ok(config.priorityPaths.includes(target), target);
  }

  assert.equal(config.promptAppend, undefined);
  assert.equal(
    readFileSync(path.join(directory, "files", "existing.json"), "utf-8"),
    "existing result"
  );

  const evidence = JSON.parse(
    readFileSync(path.join(run, "review-context.json"), "utf-8")
  );

  assert.match(evidence.infoSha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.configSha256, /^[0-9a-f]{64}$/u);
});

test("refresh delegates data writes without following guest-created host symlinks", (t) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "launch-context-boundary-")
  );

  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const run = path.join(directory, "run");
  const outside = path.join(directory, "outside");
  mkdirSync(path.join(run, "data"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "INFO.md"), "host file");
  symlinkSync(outside, path.join(run, "data", "launch"));
  let received;

  prepareReviewContext(run, (files) => {
    received = files;
  });

  assert.equal(
    readFileSync(path.join(outside, "INFO.md"), "utf-8"),
    "host file"
  );
  assert.equal(
    received["launch/INFO.md"],
    readFileSync(new URL("../INFO.md", import.meta.url), "utf-8")
  );
  assert.ok(
    JSON.parse(received["launch/config.json"]).priorityPaths.length > 0
  );
  assert.ok(
    JSON.parse(readFileSync(path.join(run, "review-context.json"), "utf-8"))
      .infoSha256
  );
});
