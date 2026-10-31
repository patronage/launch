import parse, { Element } from "html-react-parser";
import type { ReactNode } from "react";
import { z } from "zod";

/**
 * The theme's rich-text block shortcodes (inc/rich-text-blocks.php) render as
 * an empty <span> (a button) or <div> (the rest) holding the block as JSON in
 * this attribute, shaped like the content model's `RichTextBlock` with the
 * CMS's own URLs.
 */
const BLOCK_ATTRIBUTE = "data-launch-block";

const BLOCK_ELEMENT =
  /<(?<tag>span|div) data-launch-block="[^"]*"\s*><\/\k<tag>>/gu;

const text = z.string().trim().min(1);

const BlockJson = z.discriminatedUnion("type", [
  z.object({
    link: z.object({
      href: text,
      label: text,
      newTab: z.boolean().catch(false),
      variant: z.string().optional(),
    }),
    type: z.literal("button"),
  }),
  z.object({
    media: z.object({
      caption: text.optional().catch(undefined),
      image: z.object({
        alt: z.string().catch(""),
        height: z.number().optional().catch(undefined),
        src: text,
        width: z.number().optional().catch(undefined),
      }),
    }),
    type: z.literal("image"),
  }),
  z.object({
    attribution: text.optional().catch(undefined),
    quote: text,
    type: z.literal("pullquote"),
  }),
  z.object({
    caption: text.optional().catch(undefined),
    type: z.literal("embed"),
    url: text,
  }),
]);

/** A block as the theme writes it, before the adapter localizes its URLs. */
export type WordPressRichTextBlock = z.infer<typeof BlockJson>;

export const hasRichTextBlocks = (html: string): boolean =>
  html.includes(BLOCK_ATTRIBUTE);

/** Removes block elements, for renderers that cannot draw them. */
export const stripRichTextBlocks = (html: string): string =>
  html.replaceAll(BLOCK_ELEMENT, "");

/** A block element's JSON, or undefined when it is malformed or unknown. */
export const parseRichTextBlock = (
  json: string
): WordPressRichTextBlock | undefined => {
  try {
    const parsed = BlockJson.safeParse(JSON.parse(json));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Renders WordPress HTML as React elements, with each block element replaced
 * by what `renderBlock` draws. Parsing (rather than injecting the HTML) is
 * what lets a button sit inside a paragraph.
 */
export const renderHtmlWithBlocks = (
  html: string,
  renderBlock: (block: WordPressRichTextBlock) => ReactNode
): ReactNode =>
  parse(html, {
    replace: (node) => {
      const json =
        node instanceof Element ? node.attribs[BLOCK_ATTRIBUTE] : undefined;

      if (json === undefined) {
        return;
      }

      const block = parseRichTextBlock(json);

      // A malformed block is left out rather than drawn as an empty element.
      // oxlint-disable-next-line react/jsx-no-useless-fragment -- replace() must return an element, and renderBlock returns any node.
      return <>{block ? renderBlock(block) : null}</>;
    },
  });
