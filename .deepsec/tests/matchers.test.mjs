// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import { launchMatchers } from "../matchers.mjs";

const root = new URL("../../", import.meta.url);

const candidates = (file) =>
  launchMatchers.matchers.filter((matcher) =>
    matcher.filePatterns.some((pattern) => path.matchesGlob(file, pattern))
  );

test("entry-point matchers cover their examples without flagging empty files", () => {
  for (const matcher of launchMatchers.matchers) {
    for (const example of matcher.examples) {
      assert.equal(matcher.match(example).length, 1);
    }

    assert.deepEqual(matcher.match(""), []);
  }
});

test("Composer package PHP, its loader and deployment shell retain entry-point coverage", () => {
  for (const file of [
    "wordpress-shared/patronage-access/patronage-access.php",
    "wordpress-shared/patronage-fleet/patronage-fleet.php",
    "wordpress-shared/patronage-headless-revalidate/patronage-headless-revalidate.php",
    "wordpress-shared/patronage-logging/patronage-logging.php",
    "apps/cms-wordpress-headless/wp-content/mu-plugins/patronage-headless-revalidate.php",
    "apps/cms-wordpress-headless/bin/build.sh",
  ]) {
    const matches = candidates(file);
    assert.equal(matches.length, 1, file);
    assert.equal(
      matches[0].match(readFileSync(new URL(file, root), "utf-8")).length,
      1,
      file
    );
  }
});

test("the release matcher selects both executable distribution entry points", () => {
  for (const file of [
    "wordpress-shared/plugin-release/release.ts",
    "apps/docs-site/scripts/build-output.mjs",
  ]) {
    const matches = candidates(file);
    assert.equal(matches.length, 1, file);
    const hits = matches[0].match(readFileSync(new URL(file, root), "utf-8"));
    assert.equal(hits.length, 1, file);
    assert.equal(hits[0].vulnSlug, "launch-composer-release");
    assert.ok(hits[0].lineNumbers[0] > 0);
  }
});

test("release matcher scope excludes unrelated scripts and non-executable metadata", () => {
  for (const file of [
    "wordpress-shared/plugin-release/tests/release.test.ts",
    "apps/docs-site/scripts/worker-config.mjs",
    "apps/docs-site/public/composer/packages.json",
    "apps/docs-site/composer-redirects.txt",
    "wordpress-shared/patronage-fleet/composer.json",
    "wordpress-shared/patronage-access/.gitattributes",
  ]) {
    assert.deepEqual(candidates(file), [], file);
  }
});
