import { describe, expect, it } from "vitest";

import type { Page, Post, Redirect } from "@/payload-types";

import {
  destinationUrlError,
  fromCandidates,
  fromPathError,
  isSelfRedirect,
  redirectTarget,
} from "./redirects";

const ORIGIN = "https://site.example";
const pagePath = (page: Page) => `/${page.slug}`;
const to = (value: Redirect["to"]) => ({ to: value });

// SAFETY: redirectTarget reads only the slug of a populated document.
const page = { slug: "about" } as Page;

// SAFETY: as above.
const post = { slug: "hello" } as Post;

describe(fromCandidates, () => {
  it("matches with and without a trailing slash", () => {
    expect(fromCandidates("/2024/05/old")).toStrictEqual([
      "/2024/05/old",
      "/2024/05/old/",
    ]);
  });

  it("matches a decoded path against its encoded form", () => {
    expect(fromCandidates("/café")).toContain("/caf%C3%A9/");
  });
});

describe(fromPathError, () => {
  it.each(["/old", "/2024/05/old/", "/caf%C3%A9"])("accepts %s", (from) => {
    expect(fromPathError(from)).toBeUndefined();
  });

  it.each(["old", "https://site.example/old", "//host/old", "/a?b=1", "/a#b"])(
    "refuses %s",
    (from) => {
      expect(fromPathError(from)).toBeTypeOf("string");
    }
  );
});

describe(destinationUrlError, () => {
  it.each([
    "/new",
    "/new?a=1#b",
    "https://other.example/x",
    "http://a.example",
  ])("accepts %s", (url) => {
    expect(destinationUrlError(url)).toBeUndefined();
  });

  it.each([
    "new",
    "//host/x",
    "/\\host/x",
    ["javascript", "alert(1)"].join(":"),
    "ftp://a.b",
  ])("refuses %s", (url) => {
    expect(destinationUrlError(url)).toBeTypeOf("string");
  });
});

describe(redirectTarget, () => {
  it("uses a custom URL as written", () => {
    expect(redirectTarget(to({ type: "custom", url: "/new" }), pagePath)).toBe(
      "/new"
    );
  });

  it("uses a populated page's path", () => {
    expect(
      redirectTarget(
        to({
          reference: { relationTo: "pages", value: page },
          type: "reference",
        }),
        pagePath
      )
    ).toBe("/about");
  });

  it("uses a populated post's news path", () => {
    expect(
      redirectTarget(
        to({
          reference: {
            relationTo: "posts",
            value: post,
          },
          type: "reference",
        }),
        pagePath
      )
    ).toBe("/news/hello");
  });

  it("has no target when the reference wasn't readable", () => {
    expect(
      redirectTarget(
        to({ reference: { relationTo: "pages", value: 7 }, type: "reference" }),
        pagePath
      )
    ).toBeUndefined();
  });
});

describe(isSelfRedirect, () => {
  it.each([
    ["/a", "/a"],
    ["/a/", "/a"],
    ["/a?x=1", "/a"],
    [`${ORIGIN}/a`, "/a"],
    ["/caf%C3%A9", "/café"],
  ])("%s from %s loops", (target, from) => {
    expect(isSelfRedirect(target, from, ORIGIN)).toBeTruthy();
  });

  it.each([
    ["/b", "/a"],
    ["https://other.example/a", "/a"],
  ])("%s from %s does not", (target, from) => {
    expect(isSelfRedirect(target, from, ORIGIN)).toBeFalsy();
  });
});
