import { describe, expect, it } from "vitest";

import { slugify, toSkin, toSpacing, toWidth, visibleSections } from "./index";

describe("option coercion", () => {
  it("accepts strings and WPGraphQL one-item arrays", () => {
    expect(toSkin("dark")).toBe("dark");
    expect(toSkin(["accent"])).toBe("accent");
  });

  it("falls back on unknown or empty values", () => {
    expect(toSkin("purple")).toBe("light");
    expect(toWidth(null)).toBe("default");
    expect(toSpacing([], "lg")).toBe("lg");
  });
});

describe(slugify, () => {
  it("makes anchor ids", () => {
    expect(slugify("  Our Café Programs! ")).toBe("our-cafe-programs");
    expect(slugify("")).toBeUndefined();
    expect(slugify("!!!")).toBeUndefined();
  });
});

describe(visibleSections, () => {
  it("drops hidden sections", () => {
    const options = {
      paddingBottom: "md",
      paddingTop: "md",
      skin: "light",
      width: "default",
    } as const;

    const block = {
      id: "m",
      media: { image: { alt: "", src: "/a.jpg" } },
      type: "media",
    } as const;

    const page = {
      path: "/",
      sections: [
        { block, options: { ...options, hidden: false } },
        { block, options: { ...options, hidden: true } },
      ],
      title: "T",
    };

    expect(visibleSections(page)).toHaveLength(1);
  });
});
