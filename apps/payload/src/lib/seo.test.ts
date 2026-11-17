import { describe, expect, it } from "vitest";

import {
  documentMetadata,
  originForHost,
  robotsRules,
  sitemapEntries,
} from "./seo";

const ORIGIN = "https://site.example";

const base = {
  origin: ORIGIN,
  path: "/programs/seeds",
  siteName: "Demo",
  title: "Seeds",
  type: "website",
} as const;

describe(originForHost, () => {
  it.each([
    ["localhost:4173", "http://localhost:4173"],
    ["127.0.0.1:4173", "http://127.0.0.1:4173"],
    ["site.example", "https://site.example"],
    ["localhost.site.example", "https://localhost.site.example"],
  ])("%s is %s", (host, origin) => {
    expect(originForHost(host)).toBe(origin);
  });
});

describe(documentMetadata, () => {
  it("falls back to the document's title for the layout's template", () => {
    const metadata = documentMetadata(base);

    expect(metadata.title).toBe("Seeds");
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/programs/seeds`);
    expect(metadata.openGraph).toMatchObject({
      siteName: "Demo",
      title: "Seeds",
      url: `${ORIGIN}/programs/seeds`,
    });
  });

  it("leaves description unset so the layout's tagline still applies", () => {
    expect(documentMetadata(base)).not.toHaveProperty("description");
    expect(
      documentMetadata({ ...base, meta: { description: "  " } })
    ).not.toHaveProperty("description");
  });

  it("uses the editor's title as written and description over the fallback", () => {
    const metadata = documentMetadata({
      ...base,
      description: "Excerpt",
      meta: { description: "Written", title: "Exact title" },
    });

    expect(metadata.title).toStrictEqual({ absolute: "Exact title" });
    expect(metadata.description).toBe("Written");
    expect(metadata.openGraph?.title).toBe("Exact title");
  });

  it("prefers the SEO image and makes it absolute", () => {
    const metadata = documentMetadata({
      ...base,
      fallbackImage: { alt: "Hero", src: "/media/hero.jpg" },
      image: { alt: "Social", src: "/media/social.jpg" },
    });

    expect(metadata.openGraph?.images).toStrictEqual([
      { alt: "Social", url: `${ORIGIN}/media/social.jpg` },
    ]);
  });

  it("falls back to the document's image", () => {
    expect(
      documentMetadata({
        ...base,
        fallbackImage: { alt: "Hero", src: "/media/hero.jpg" },
      }).openGraph?.images
    ).toStrictEqual([{ alt: "Hero", url: `${ORIGIN}/media/hero.jpg` }]);
  });

  it("marks hidden documents noindex", () => {
    expect(
      documentMetadata({ ...base, meta: { noindex: true } }).robots
    ).toStrictEqual({ follow: true, index: false });
    expect(documentMetadata(base)).not.toHaveProperty("robots");
  });
});

describe(sitemapEntries, () => {
  const updatedAt = "2026-11-01T00:00:00.000Z";

  it("lists documents with absolute URLs", () => {
    expect(sitemapEntries(ORIGIN, [{ path: "/", updatedAt }])).toStrictEqual([
      { lastModified: updatedAt, url: `${ORIGIN}/` },
    ]);
  });

  it("drops hidden documents and those without a path", () => {
    expect(
      sitemapEntries(ORIGIN, [
        { meta: { noindex: true }, path: "/hidden", updatedAt },
        { path: undefined, updatedAt },
      ])
    ).toStrictEqual([]);
  });
});

describe(robotsRules, () => {
  it("points crawlers at the sitemap and away from the CMS", () => {
    expect(robotsRules(ORIGIN)).toStrictEqual({
      rules: {
        allow: "/",
        disallow: ["/admin/", "/api/", "/forms/", "/next/"],
        userAgent: "*",
      },
      sitemap: `${ORIGIN}/sitemap.xml`,
    });
  });

  it("closes workers.dev hostnames", () => {
    expect(robotsRules("https://launch.team.workers.dev")).toStrictEqual({
      rules: { disallow: "/", userAgent: "*" },
    });
  });
});
