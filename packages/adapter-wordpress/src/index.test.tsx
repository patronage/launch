import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  wordpressGetInvolvedFixture,
  wordpressGuideFixture,
  wordpressHomeFixture,
} from "../fixtures";
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

  it("reads section options and slugifies anchors", () => {
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

  it("leaves the hero out of a page without a variant", () => {
    expect(page.hero).toBeUndefined();
  });
});

describe("WordPress heroes and forms", () => {
  const getInvolved = adapter.toPage(wordpressGetInvolvedFixture);

  it("maps a hero, defaulting its title to the page title", () => {
    expect(getInvolved?.hero).toMatchObject({
      eyebrow: "Volunteer",
      image: { alt: "Volunteers sorting a harvest" },
      links: [{ href: "/get-involved", label: "Sign up below" }],
      skin: "light",
      title: "Get involved",
      variant: "split",
    });
    expect(getInvolved?.path).toBe("/get-involved");
  });

  it("maps a Formidable form and posts it to the form action", () => {
    const block = getInvolved?.sections[0]?.block;
    const form = block?.type === "form" ? block.form : undefined;

    expect(form).toMatchObject({
      action: "/forms/submit",
      submitLabel: "Sign up",
    });
    expect(
      form?.fields.map((field) => [field.name, field.width])
    ).toStrictEqual([
      ["name", 50],
      ["email", 50],
      ["interest", 50],
      ["note", undefined],
      ["newsletter", undefined],
    ]);
    expect(renderToStaticMarkup(form?.confirmation)).toContain(
      "before the next volunteer day"
    );
  });
});

describe("WordPress rich-text blocks", () => {
  const blocks: unknown[] = [];

  const withBlocks = createWordPressAdapter({
    cmsOrigin: "https://cms.example.com",
    renderRichTextBlock: (block) => {
      blocks.push(block);

      return <aside data-type={block.type} />;
    },
  }).toPage(wordpressGuideFixture);

  const body = (value: typeof withBlocks) => {
    const block = value?.sections[0]?.block;

    return renderToStaticMarkup(block?.type === "content" ? block.body : null);
  };

  it("draws each block where it sits, a button inside its paragraph", () => {
    expect(body(withBlocks)).toContain(
      'set a watering rota before the first hot week. <aside data-type="button"></aside></p>'
    );
    expect(renderToStaticMarkup(withBlocks?.hero?.body)).toContain(
      '<aside data-type="embed"></aside>'
    );
  });

  it("maps blocks to the content model, with site-relative links", () => {
    expect(blocks).toContainEqual({
      attribution: "Rosa Delgado, garden lead",
      quote:
        "Test first, plant second. Raised beds fix almost anything the test finds.",
      type: "pullquote",
    });
    expect(blocks).toContainEqual({
      link: {
        href: "/get-involved",
        label: "Find a mentor",
        newTab: false,
        variant: "text",
      },
      type: "button",
    });
    expect(blocks).toContainEqual(
      expect.objectContaining({
        media: expect.objectContaining({
          caption: "Raised beds on a former parking lot",
        }),
        type: "image",
      })
    );
  });

  it("leaves blocks out without a block renderer", () => {
    const markup = body(adapter.toPage(wordpressGuideFixture));

    expect(markup).not.toContain("data-launch-block");
    expect(markup).toContain("Before anything goes in the ground");
  });
});
