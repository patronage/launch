import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sameSitePath } from "./same-site-path";

const ORIGIN = "https://site.example";

// A module's source without the line that says it is a copy.
const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf-8")
    .split("\n")
    .filter((line) => !line.startsWith("// A copy of"))
    .join("\n")
    .trim();

describe(sameSitePath, () => {
  it("keeps a path on this site with its query and hash", () => {
    expect(sameSitePath("/about/?a=1#team", ORIGIN)).toBe("/about/?a=1#team");
  });

  it.each([
    "//evil.example/",
    "/\\evil.example",
    "/\\/evil.example",
    "/\t/evil.example",
    "https://evil.example/",
    "evil.example",
    "",
  ])("refuses %j", (path) => {
    expect(sameSitePath(path, ORIGIN)).toBeUndefined();
  });

  it("collapses a path that dot segments turn into //host", () => {
    expect(sameSitePath("/section/..//evil.example/", ORIGIN)).toBe(
      "/evil.example/"
    );
  });

  // The preview route redirects to what this returns, so the copy must not
  // drift from web-wordpress's, which the two front ends share by copy.
  it("matches the web-wordpress copy line for line", () => {
    expect(source("same-site-path.ts")).toBe(
      source("../../../web-wordpress/lib/same-site-path.ts")
    );
  });
});
