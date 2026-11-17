import { describe, expect, it } from "vitest";

import { publicPathOf } from "./preview";

describe(publicPathOf, () => {
  it("reads the public path out of a preview link", () => {
    expect(publicPathOf("/next/preview?path=%2Fnews%2Fhello-world")).toBe(
      "/news/hello-world"
    );
  });

  it.each([
    ["no link", null],
    ["a link to somewhere else", "/other?path=%2Fnews%2Fhello"],
    ["a link with no path", "/next/preview?slug=hello"],
    [
      "a path that is not on the site",
      "/next/preview?path=https%3A%2F%2Fa.example",
    ],
  ])("gives nothing for %s", (_name, link) => {
    expect(publicPathOf(link)).toBeNull();
  });
});
