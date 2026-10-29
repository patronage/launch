import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { payloadHomeFixture } from "../fixtures";
import { createPayloadAdapter } from "./index";
import { renderLexical } from "./lexical";
import type { LexicalNode, LexicalState } from "./types";

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
        src: "https://cms.example.com/api/media/file/harvest.jpg",
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
