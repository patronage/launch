import { describe, expect, it } from "vitest";

import { sameSitePath } from "./same-site-path";

const ORIGIN = "https://site.example";

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
});
