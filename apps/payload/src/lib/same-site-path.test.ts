import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sameSitePath } from "./same-site-path";

// A module's source without the line that says it is a copy.
const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf-8")
    .split("\n")
    .filter((line) => !line.startsWith("// A copy of"))
    .join("\n")
    .trim();

describe(sameSitePath, () => {
  // The preview route redirects to what this returns, so the copy must not
  // drift from web-wordpress's, which the two front ends share by copy. The
  // behaviour itself is tested once, against that copy, in
  // apps/web-wordpress/lib/same-site-path.test.ts.
  it("matches the web-wordpress copy line for line", () => {
    expect(source("same-site-path.ts")).toBe(
      source("../../../web-wordpress/lib/same-site-path.ts")
    );
  });
});
