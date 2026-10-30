import type { Page } from "@launch/content-model";
import { DEFAULT_SECTION_OPTIONS } from "@launch/content-model";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
