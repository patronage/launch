import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { wordpressHomeFixture } from "../fixtures";
import { createWordPressAdapter } from "./index";

const adapter = createWordPressAdapter({
  cmsOrigin: "https://cms.example.com/",
});

const page = adapter.toPage(wordpressHomeFixture);

if (!page) {
  throw new Error("fixture did not map");
}

const [intro, contentMedia, cards, quote, media, cta, hidden] = page.sections;

describe("WordPress adapter", () => {
  it("maps the page and skips unknown layouts", () => {
    expect(page.path).toBe("/");
    expect(page.sections.map((s) => s.block.type)).toStrictEqual([
      "content",
      "contentMedia",
      "cardGrid",
      "blockquote",
      "media",
      "callToAction",
      "callToAction",
    ]);
  });

  it("reads one-item select arrays and slugifies anchors", () => {
    expect(intro?.options).toStrictEqual({
      hidden: false,
      paddingBottom: "lg",
      paddingTop: "lg",
      skin: "accent",
      slug: "intro",
      width: "narrow",
    });
    expect(hidden?.options.hidden).toBeTruthy();
  });

  it("makes CMS links site-relative and keeps external links", () => {
    expect(intro?.block.type === "content" && intro.block.links).toStrictEqual([
      {
        href: "/get-involved",
        label: "Get involved",
        newTab: false,
        variant: "primary",
      },
      {
        href: "https://maps.example.org/gardens",
        label: "Garden map",
        newTab: true,
        variant: "secondary",
      },
    ]);
  });

  it("rewrites CMS hrefs inside rich text", () => {
    const body =
      contentMedia?.block.type === "contentMedia"
        ? contentMedia.block.body
        : null;

    expect(renderToStaticMarkup(body)).toContain(
      '<a href="/guide">the starter guide</a>'
    );
  });

  it("strips HTML from captions", () => {
    expect(media?.block.type === "media" && media.block.media.caption).toBe(
      "Fall harvest day"
    );
  });

  it("drops cards without titles' optional parts cleanly", () => {
    expect(
      cards?.block.type === "cardGrid" && cards.block.cards[2]
    ).toStrictEqual({
      id: "cardgrid-2-card-2",
      text: "After-school planting and harvest days.",
      title: "Youth growers",
    });
    expect(cards?.block.type === "cardGrid" && cards.block.columns).toBe(3);
  });

  it("maps blockquote and call to action", () => {
    expect(quote?.block).toMatchObject({
      quote: expect.stringContaining("garden"),
      role: "Garden lead",
    });
    expect(cta?.block).toMatchObject({
      heading: "Start a garden on your block",
    });
  });

  it("applies the image URL rewrite", () => {
    const cdn = createWordPressAdapter({
      cmsOrigin: "https://cms.example.com",
      imageUrl: (src) =>
        src.replace(
          "https://cms.example.com/wp-content/uploads/",
          "https://img.example.com/"
        ),
    }).toPage(wordpressHomeFixture);

    const block = cdn?.sections[4]?.block;
    expect(block?.type === "media" && block.media.image.src).toBe(
      "https://img.example.com/2026/10/harvest.jpg"
    );
  });

  it("returns undefined for a missing page", () => {
    expect(adapter.toPage({ data: { page: null } })).toBeUndefined();
  });
});
