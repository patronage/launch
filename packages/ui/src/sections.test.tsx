import type {
  Page,
  RichTextBlock as RichTextBlockModel,
} from "@launch/content-model";
import { DEFAULT_SECTION_OPTIONS } from "@launch/content-model";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RichTextBlock } from "./rich-text-blocks";
import { PageSections } from "./sections";

const page: Page<ReactNode> = {
  path: "/test",
  sections: [
    {
      block: {
        align: "center",
        body: <p>Body</p>,
        heading: "Hello",
        id: "a",
        links: [
          {
            href: "https://example.org",
            label: "Go",
            newTab: true,
            variant: "primary",
          },
        ],
        type: "content",
      },
      options: { ...DEFAULT_SECTION_OPTIONS, skin: "dark", slug: "intro" },
    },
    {
      block: { heading: "Hidden", id: "b", links: [], type: "callToAction" },
      options: { ...DEFAULT_SECTION_OPTIONS, hidden: true },
    },
    {
      block: {
        attribution: "Ada",
        id: "c",
        quote: "Quote",
        role: "Engineer",
        type: "blockquote",
      },
      options: DEFAULT_SECTION_OPTIONS,
    },
    {
      block: {
        form: {
          action: "/forms/submit",
          fields: [
            { label: "Email", name: "email", required: true, type: "email" },
            {
              name: "topic",
              options: [{ label: "Seeds", value: "seeds" }],
              required: false,
              type: "select",
            },
            {
              message: <p>Fine print</p>,
              name: "",
              required: false,
              type: "message",
            },
          ],
          id: "1",
          submitLabel: "Send",
        },
        id: "d",
        type: "form",
      },
      options: DEFAULT_SECTION_OPTIONS,
    },
  ],
  title: "Test",
};

describe(PageSections, () => {
  const html = renderToStaticMarkup(<PageSections page={page} />);

  it("applies section options as attributes and classes", () => {
    expect(html).toMatch(
      /<section class="[^"]*pb-section-md pt-section-md[^"]*" data-component="section" data-skin="dark" id="intro">/u
    );
    expect(html).toMatch(
      /<div class="mx-auto w-full px-gutter max-w-6xl" data-component="container" data-width="default">/u
    );
  });

  it("makes the first heading the h1 and later ones h2", () => {
    expect(html).toMatch(
      /<h1 class="[^"]*text-section-heading[^"]*">Hello<\/h1>/u
    );
    expect(html).not.toContain("<h2");
  });

  it("drops the bottom padding between sections with the same skin", () => {
    const light = [
      ...html.matchAll(
        /<section class="[^"]*(?<bottom>pb-[\w-]+)[^"]*" data-component="section" data-skin="light"/gu
      ),
    ].map((match) => match.groups?.bottom);

    expect(light).toStrictEqual(["pb-0", "pb-section-md"]);
  });

  it("drops hidden sections", () => {
    expect(html).not.toContain("Hidden");
  });

  it("passes rich text through untouched", () => {
    expect(html).toMatch(
      /<div class="prose-section [^"]*"><p>Body<\/p><\/div>/u
    );
  });

  it("adds rel to new-tab links", () => {
    expect(html).toContain('rel="noopener noreferrer" target="_blank"');
  });

  it("renders form fields with labels tied to their inputs", () => {
    const label = /<label class="[^"]*" for="(?<id>[^"]+)">Email/u.exec(html);

    expect(label).not.toBeNull();
    expect(html).toMatch(
      new RegExp(
        `<input [^>]*id="${label?.groups?.id}" required="" name="email"`,
        "u"
      )
    );
    expect(html).toContain('<option value="seeds">Seeds</option>');
    expect(html).toContain("<p>Fine print</p>");
    expect(html).toContain(">Send</button>");
  });
});

const draw = (block: RichTextBlockModel) =>
  renderToStaticMarkup(<RichTextBlock block={block} />);

describe(RichTextBlock, () => {
  it("plays YouTube and Vimeo without tracking cookies", () => {
    expect(
      draw({
        type: "embed",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      })
    ).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(
      draw({ type: "embed", url: "https://vimeo.com/76979871" })
    ).toContain('src="https://player.vimeo.com/video/76979871?dnt=1"');
    expect(
      draw({ type: "embed", url: "https://vimeo.com/76979871/abc123def" })
    ).toContain(
      'src="https://player.vimeo.com/video/76979871?dnt=1&amp;h=abc123def"'
    );
    expect(
      draw({ type: "embed", url: "https://notvimeo.com/76979871" })
    ).not.toContain("<iframe");
  });

  it("draws an X post with X's widget", () => {
    expect(
      draw({ type: "embed", url: "https://x.com/payloadcms/status/1234567890" })
    ).toContain('<blockquote class="twitter-tweet" data-dnt="true">');
  });

  it("links other URLs instead of framing them, and drops non-https ones", () => {
    const html = draw({
      caption: "Report",
      type: "embed",
      url: "https://example.org/r",
    });

    expect(html).not.toContain("<iframe");
    expect(html).toContain('href="https://example.org/r"');
    expect(draw({ type: "embed", url: "http://example.org/r" })).toBe("");
  });

  it("draws an inline button as a lone link", () => {
    expect(
      draw({
        link: {
          href: "/apply",
          label: "Apply",
          newTab: false,
          variant: "primary",
        },
        type: "button",
      })
    ).toMatch(
      /^<a class="[^"]*" data-variant="primary" href="\/apply">Apply<\/a>$/u
    );
  });
});

describe("PageSections with a hero", () => {
  const withHero = renderToStaticMarkup(
    <PageSections
      page={{
        ...page,
        hero: {
          align: "start",
          links: [],
          skin: "dark",
          title: "Welcome",
          variant: "simple",
        },
      }}
    />
  );

  it("gives the hero the only h1", () => {
    expect(withHero.match(/<h1/gu)).toHaveLength(1);
    expect(withHero).toMatch(/<h1 class="[^"]*">Welcome<\/h1>/u);
    expect(withHero).toMatch(/<h2 class="[^"]*">Hello<\/h2>/u);
  });

  it("joins the hero to a first section with the same skin", () => {
    expect(withHero).toMatch(
      /<section class="[^"]*pb-0[^"]*" data-component="section" data-skin="dark" data-hero="simple">/u
    );
  });
});
