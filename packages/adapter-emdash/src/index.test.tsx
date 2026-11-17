import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  emdashGetInvolvedFixture,
  emdashGuideFixture,
  emdashHomeFixture,
} from "../fixtures";
import { createEmDashAdapter, renderPortableText } from "./index";
import type { EmDashPageData, PortableText } from "./types";

const adapter = createEmDashAdapter({ serverUrl: "https://cms.example.com/" });
const page = adapter.toPage(emdashHomeFixture.item);
const [intro, contentMedia, cards, quote, media, , hidden] = page.sections;

/** Rendered markup, without the wrapper the renderer needs. */
const html = (node: ReactNode) =>
  renderToStaticMarkup(<div>{node}</div>).slice(
    "<div>".length,
    -"</div>".length
  );

describe("EmDash adapter", () => {
  it("maps the home page's sections in order", () => {
    expect(page.path).toBe("/");
    expect(page.title).toBe("Home");
    expect(page.hero).toBeUndefined();
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

  it("maps section options", () => {
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

  it("maps links, keeping their style and target", () => {
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

  it("resolves R2 media through EmDash's file route", () => {
    const block = media?.block;

    expect(block?.type === "media" && block.media.caption).toBe(
      "Fall harvest day"
    );
    expect(block?.type === "media" && block.media.image.src).toMatch(
      /^https:\/\/cms\.example\.com\/_emdash\/api\/media\/file\/[\dA-Z]+\.jpg$/u
    );
    expect(block?.type === "media" && block.media.image.alt).toBe(
      "Volunteers sorting a harvest"
    );
  });

  it("styles card links as text and drops cards' missing links", () => {
    const grid = cards?.block.type === "cardGrid" ? cards.block : undefined;

    expect(grid?.columns).toBe(3);
    expect(grid?.cards[0]?.link).toStrictEqual({
      href: "/seed-library",
      label: "Browse seeds",
      newTab: false,
      variant: "text",
    });
    expect(grid?.cards[2]?.link).toBeUndefined();
    expect(grid?.cards[2]?.image).toBeUndefined();
  });

  it("renders Portable Text with marks, links and grouped lists", () => {
    expect(
      contentMedia?.block.type === "contentMedia" &&
        html(contentMedia.block.body)
    ).toBe(
      '<ul><li>Find a lot</li><li>Gather <em>five</em> neighbors</li></ul><p>Read <a href="/guide">the starter guide</a>.</p>'
    );
    expect(intro?.block.type === "content" && html(intro.block.body)).toBe(
      "<p>We help neighbors turn empty lots into <strong>shared gardens</strong>.</p>"
    );
  });

  it("maps the blockquote", () => {
    expect(quote?.block.type === "blockquote" && quote.block.role).toBe(
      "Garden lead"
    );
  });

  it("maps a split hero's own fields", () => {
    const split = adapter.toPage(emdashGetInvolvedFixture.item);

    expect(split.path).toBe("/get-involved");
    expect(split.hero?.variant).toBe("split");
    expect(split.hero?.title).toBe("Get involved");
    expect(split.hero?.image?.alt).toBe("Volunteers sorting a harvest");
  });

  it("maps a free-form hero's body and alignment", () => {
    const freeform = adapter.toPage(emdashGuideFixture.item);

    expect(freeform.hero?.variant).toBe("freeform");
    expect(freeform.hero?.title).toBe("Your first season");
    expect(freeform.hero?.align).toBe("center");
    expect(html(freeform.hero?.body)).toBe(
      "<p>Everything a new garden needs in its first season, from a <strong>soil test</strong> to a watering rota.</p>"
    );
  });

  it("skips unknown and incomplete sections", () => {
    const data: EmDashPageData = {
      sections: [
        { _key: "a", _type: "map_embed" },
        { _key: "b", _type: "call_to_action" },
        { _key: "c", _type: "media" },
        { _key: "d", _type: "content", heading: "Kept" },
      ],
      title: "Test",
    };

    expect(
      adapter.toPage({ data, slug: "test" }).sections.map((s) => s.block.id)
    ).toStrictEqual(["d"]);
  });

  it("renders the published data it is given, not the draft", () => {
    const live: EmDashPageData = { hero_variant: "none", title: "Live" };

    expect(adapter.toPage(emdashHomeFixture.item, live).title).toBe("Live");
  });
});

describe("Portable Text", () => {
  it("returns undefined for a cleared editor", () => {
    expect(
      renderPortableText([
        { _type: "block", children: [{ _type: "span", text: " " }] },
      ])
    ).toBeUndefined();
    expect(renderPortableText(undefined)).toBeUndefined();
  });

  it("drops unsafe link schemes but keeps their text", () => {
    const nodes: PortableText = [
      {
        _type: "block",
        children: [{ _type: "span", marks: ["l"], text: "click" }],
        // oxlint-disable-next-line no-script-url -- the case under test.
        markDefs: [{ _key: "l", _type: "link", href: "javascript:alert(1)" }],
      },
    ];

    expect(html(renderPortableText(nodes))).toBe("<p>click</p>");
  });

  it("caps headings at h2 and passes images to the block renderer", () => {
    const withImages = createEmDashAdapter({
      renderRichTextBlock: (block) =>
        block.type === "image" ? (
          <img alt={block.media.image.alt} src={block.media.image.src} />
        ) : null,
      serverUrl: "https://cms.example.com",
    });

    const result = withImages.toPage({
      data: {
        sections: [
          {
            _type: "content",
            body: [
              {
                _type: "block",
                children: [{ _type: "span", text: "Top" }],
                style: "h1",
              },
              {
                _type: "image",
                alt: "Beds",
                asset: { url: "/_emdash/api/media/file/x.jpg" },
              },
              { _type: "plugin_widget" },
            ],
          },
        ],
        title: "T",
      },
      slug: "t",
    });

    const body = result.sections[0]?.block;

    const markup = body?.type === "content" ? html(body.body) : "";

    // React adds a preload <link> for the image; the order of the rest holds.
    expect(markup).toContain(
      '<h2>Top</h2><img alt="Beds" src="https://cms.example.com/_emdash/api/media/file/x.jpg"/>'
    );
  });
});
