import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { payloadHomeFixture } from "../fixtures";
import { createPayloadAdapter } from "./index";
import { renderLexical } from "./lexical";
import type { LexicalNode, LexicalState, PayloadHero } from "./types";

const adapter = createPayloadAdapter({ serverUrl: "https://cms.example.com" });
const page = adapter.toPage(payloadHomeFixture);
const [intro, contentMedia, cards, , media, , hidden] = page.sections;

describe("Payload adapter", () => {
  it("maps the page and skips unknown blocks", () => {
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

  it("resolves reference links to paths, preferring breadcrumbs", () => {
    expect(intro?.block.type === "content" && intro.block.links[0]?.href).toBe(
      "/get-involved"
    );
    expect(
      cards?.block.type === "cardGrid" && cards.block.cards[0]?.link
    ).toStrictEqual({
      href: "/programs/seed-library",
      label: "Browse seeds",
      newTab: false,
      variant: "text",
    });
  });

  it("resolves relative media URLs against the server URL", () => {
    expect(media?.block.type === "media" && media.block.media).toStrictEqual({
      caption: "Fall harvest day",
      image: {
        alt: "Volunteers sorting a harvest",
        height: 1200,
        src: "https://cms.example.com/api/media/file/harvest-original.jpg",
        width: 2400,
      },
    });
  });

  it("renders Lexical lists, formats and internal links", () => {
    const body =
      contentMedia?.block.type === "contentMedia"
        ? contentMedia.block.body
        : null;

    expect(renderToStaticMarkup(body)).toBe(
      '<ul><li>Find a lot</li><li>Gather <em>five</em> neighbors</li></ul><p>Read <a href="/guide">the starter guide</a>.</p>'
    );
  });

  it("drops images it cannot resolve at depth 0", () => {
    const shallow = createPayloadAdapter().toPage({
      id: 2,
      layout: [{ blockType: "media", media: 45 }],
      slug: "about",
    });

    expect(shallow.path).toBe("/about");
    expect(shallow.sections).toStrictEqual([]);
  });

  it("maps a populated form and drops one left as an id", () => {
    const { sections } = createPayloadAdapter({
      formAction: "/submit",
    }).toPage({
      id: 3,
      layout: [
        {
          blockType: "form",
          form: {
            confirmationType: "redirect",
            fields: [
              {
                blockType: "text",
                label: "Name",
                name: "name",
                required: true,
              },
              {
                blockType: "select",
                name: "size",
                options: [{ label: "Small", value: "s" }, { value: "" }],
                width: 50,
              },
              { blockType: "checkbox", defaultValue: true, name: "news" },
              { blockType: "payment", name: "amount" },
              { blockType: "email" },
            ],
            id: 7,
            submitButtonLabel: "",
          },
          heading: "Sign up",
        },
        { blockType: "form", form: 7 },
      ],
      slug: "join",
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.block).toStrictEqual({
      form: {
        action: "/submit",
        fields: [
          { label: "Name", name: "name", required: true, type: "text" },
          {
            name: "size",
            options: [{ label: "Small", value: "s" }],
            required: false,
            type: "select",
            width: 50,
          },
          {
            defaultValue: "true",
            name: "news",
            required: false,
            type: "checkbox",
          },
        ],
        id: "7",
        submitLabel: "Submit",
      },
      heading: "Sign up",
      id: "form-0",
      type: "form",
    });
  });
});

const text = (value: string, format = 0) => ({
  format,
  text: value,
  type: "text",
  version: 1,
});

const state = (...children: LexicalNode[]): LexicalState => ({
  root: { children, type: "root", version: 1 },
});

const render = (s: LexicalState) =>
  renderToStaticMarkup(renderLexical(s, { resolveDoc: () => {} }));

describe(renderLexical, () => {
  it("treats an empty editor as no content", () => {
    expect(
      renderLexical(state({ children: [], type: "paragraph", version: 1 }), {
        resolveDoc: () => {},
      })
    ).toBeUndefined();
  });

  it("nests combined formats and caps headings at h2", () => {
    expect(
      render(
        state(
          { children: [text("Title")], tag: "h1", type: "heading", version: 1 },
          {
            children: [
              text("both", 3),
              { type: "linebreak", version: 1 },
              text("x", 16),
            ],
            type: "paragraph",
            version: 1,
          }
        )
      )
    ).toBe(
      "<h2>Title</h2><p><strong><em>both</em></strong><br/><code>x</code></p>"
    );
  });

  it("keeps the text of unknown nodes", () => {
    expect(
      render(state({ children: [text("kept")], type: "mystery", version: 1 }))
    ).toBe("kept");
  });
});

describe("rich-text blocks", () => {
  const drawn = createPayloadAdapter({
    renderRichTextBlock: (block) => <i data-block={block.type} />,
    serverUrl: "https://cms.example.com",
  });

  it("maps each block to the content model", () => {
    expect(
      drawn.richTextBlock({
        blockType: "image",
        caption: " ",
        image: { alt: "Beds", caption: "Own", id: 1, url: "/a.jpg" },
      })
    ).toStrictEqual({
      media: {
        caption: "Own",
        image: { alt: "Beds", src: "https://cms.example.com/a.jpg" },
      },
      type: "image",
    });
    expect(
      drawn.richTextBlock({
        blockType: "button",
        link: { label: "Go", type: "custom", url: "/go", variant: "secondary" },
      })
    ).toStrictEqual({
      link: { href: "/go", label: "Go", newTab: false, variant: "secondary" },
      type: "button",
    });
    expect(drawn.richTextBlock({ blockType: "pullquote" })).toBeUndefined();
    expect(
      drawn.richTextBlock({ blockType: "image", image: 3 })
    ).toBeUndefined();
  });

  it("hands block and inline-block nodes to renderRichTextBlock", () => {
    const body = drawn.toPage({
      ...payloadHomeFixture,
      layout: [
        {
          blockType: "content",
          body: state(
            {
              fields: { blockType: "embed", url: "https://youtu.be/abc123" },
              type: "block",
              version: 1,
            },
            {
              children: [
                text("Then "),
                {
                  fields: {
                    blockType: "button",
                    link: { label: "Go", type: "custom", url: "/go" },
                  },
                  type: "inlineBlock",
                  version: 1,
                },
              ],
              type: "paragraph",
              version: 1,
            }
          ),
          id: "x",
        },
      ],
    }).sections[0]?.block;

    expect(
      body?.type === "content" && renderToStaticMarkup(<div>{body.body}</div>)
    ).toBe(
      '<div><i data-block="embed"></i><p>Then <i data-block="button"></i></p></div>'
    );
  });

  it("leaves blocks out without renderRichTextBlock", () => {
    expect(
      render(
        state({
          fields: { blockType: "pullquote", quote: "Q" },
          type: "block",
          version: 1,
        })
      )
    ).toBe("");
  });
});

const withHero = (hero: PayloadHero) =>
  adapter.toPage({ ...payloadHomeFixture, hero }).hero;

describe("heroes", () => {
  it("has no hero without a variant", () => {
    expect(withHero({ title: "Kept" })).toBeUndefined();
  });

  it("adds a srcset from the rewritten URL and original width", () => {
    const responsive = createPayloadAdapter({
      imageSrcset: (src, width) => `${src}?w=480 480w (of ${width})`,
      imageUrl: (src) => `/media${src}`,
    });

    expect(
      responsive.richTextBlock({
        blockType: "image",
        image: { alt: "Beds", id: 1, url: "/a.jpg", width: 900 },
      })
    ).toStrictEqual({
      media: {
        image: {
          alt: "Beds",
          src: "/media/a.jpg",
          srcset: "/media/a.jpg?w=480 480w (of 900)",
          width: 900,
        },
      },
      type: "image",
    });
  });

  it("maps the hero, defaulting the title to the page's", () => {
    expect(
      withHero({
        body: state({
          children: [text("Hidden")],
          type: "paragraph",
          version: 1,
        }),
        image: { alt: "Beds", id: 1, url: "/a.jpg" },
        subhead: "Sub",
        variant: "split",
      })
    ).toStrictEqual({
      align: "start",
      image: { alt: "Beds", src: "https://cms.example.com/a.jpg" },
      links: [],
      skin: "light",
      subhead: "Sub",
      title: payloadHomeFixture.title,
      variant: "split",
    });
  });

  it("draws rich text only in a free-form hero", () => {
    const hero = withHero({
      body: state({ children: [text("Body")], type: "paragraph", version: 1 }),
      image: { alt: "Beds", id: 1, url: "/a.jpg" },
      subhead: "Dropped",
      title: "Free",
      variant: "freeform",
    });

    expect(hero?.subhead).toBeUndefined();
    expect(hero?.image).toBeUndefined();
    expect(renderToStaticMarkup(<div>{hero?.body}</div>)).toBe(
      "<div><p>Body</p></div>"
    );
  });
});
