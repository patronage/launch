import { HERO_VARIANTS, SKINS } from "@launch/content-model";
import {
  BoldFeature,
  FixedToolbarFeature,
  HeadingFeature,
  InlineToolbarFeature,
  ItalicFeature,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  UnorderedListFeature,
  lexicalEditor,
} from "@payloadcms/richtext-lexical";
import type { Condition, Field } from "payload";

import { richTextBlocks } from "../rich-text/blocks";
import { link } from "./link";

const LABELS = {
  freeform: "Free-form (rich text)",
  home: "Home (title over image)",
  media: "Media (image below)",
  simple: "Simple (no image)",
  split: "Split (image beside)",
} satisfies Record<(typeof HERO_VARIANTS)[number], string>;

/** Shown for the listed variants only. */
const forVariants =
  (...variants: string[]): Condition =>
  (_, siblingData) =>
    variants.includes(String(siblingData?.variant));

const withHero = forVariants(...HERO_VARIANTS);

/**
 * The free-form hero's editor: headings below the title, a few marks, links,
 * and the rich-text blocks, so an editor can lay out an inline button, an
 * image or a video under the title.
 */
const heroEditor = lexicalEditor({
  features: () => [
    ParagraphFeature(),
    HeadingFeature({ enabledHeadingSizes: ["h2", "h3"] }),
    BoldFeature(),
    ItalicFeature(),
    LinkFeature({ enabledCollections: ["pages"] }),
    UnorderedListFeature(),
    OrderedListFeature(),
    richTextBlocks(),
    FixedToolbarFeature(),
    InlineToolbarFeature(),
  ],
});

/**
 * The page hero, shaped after `Hero` in the content model. With no variant
 * the page has no hero, and its first section's heading is the <h1>.
 */
export const hero: Field = {
  fields: [
    {
      admin: {
        description: "Leave empty for no hero.",
      },
      name: "variant",
      options: HERO_VARIANTS.map((value) => ({ label: LABELS[value], value })),
      type: "select",
    },
    {
      admin: {
        condition: withHero,
        description: "Defaults to the page title.",
      },
      name: "title",
      type: "text",
    },
    {
      admin: { condition: withHero },
      fields: [
        { admin: { width: "50%" }, name: "eyebrow", type: "text" },
        {
          admin: { width: "25%" },
          defaultValue: "light",
          name: "skin",
          options: SKINS.map((value) => ({ label: value, value })),
          type: "select",
        },
        {
          admin: { width: "25%" },
          defaultValue: "start",
          name: "align",
          options: ["start", "center"],
          type: "select",
        },
      ],
      type: "row",
    },
    {
      admin: {
        condition: forVariants("home", "split", "media", "simple"),
      },
      name: "subhead",
      type: "textarea",
    },
    {
      admin: {
        condition: forVariants("freeform"),
        description: "Headings, buttons, images and videos under the title.",
      },
      editor: heroEditor,
      name: "body",
      type: "richText",
    },
    {
      admin: { condition: forVariants("home", "split", "media") },
      name: "image",
      relationTo: "media",
      type: "upload",
    },
    {
      admin: { condition: withHero },
      fields: [link()],
      name: "links",
      type: "array",
    },
  ],
  interfaceName: "PageHero",
  name: "hero",
  type: "group",
};
