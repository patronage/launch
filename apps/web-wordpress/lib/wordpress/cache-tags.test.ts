import { describe, expect, it } from "vitest";

import { pathTag, smartCacheTags } from "./cache-tags";

describe(smartCacheTags, () => {
  it("keeps node, list and skipped keys, and drops keys every response has", () => {
    const header = [
      "fd9f97d9f7c78749b1b9a095b70adbca5a4e18454330129cefa7a65bd1cbb6b5",
      "graphql:Query",
      "operation:Layout",
      "list:menuitem",
      "cG9zdDoxMg==",
      "skipped:post",
      "cG9zdDoxMg==",
    ].join(" ");

    expect(smartCacheTags(header)).toStrictEqual([
      "list:menuitem",
      "cG9zdDoxMg==",
      "skipped:post",
    ]);
  });

  it("returns no tags without a header", () => {
    expect(smartCacheTags(null)).toStrictEqual([]);
    expect(smartCacheTags("  ")).toStrictEqual([]);
  });
});

describe(pathTag, () => {
  it("gives a WordPress URI and the path WordPress sends the same tag", () => {
    expect(pathTag("/programs/seed-library/")).toBe(
      "path:/programs/seed-library"
    );
    expect(pathTag("/programs/seed-library")).toBe(
      "path:/programs/seed-library"
    );
  });

  it("matches WordPress's lowercase percent escapes to encodeURIComponent's", () => {
    expect(pathTag("/%e6%97%a5")).toBe(
      pathTag(`/${encodeURIComponent("日")}/`)
    );
  });

  it("keeps the home page as /", () => {
    expect(pathTag("/")).toBe("path:/");
  });
});
