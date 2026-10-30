import {
  BlockquoteFeature,
  BoldFeature,
  FixedToolbarFeature,
  HeadingFeature,
  HorizontalRuleFeature,
  InlineCodeFeature,
  InlineToolbarFeature,
  ItalicFeature,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  StrikethroughFeature,
  SubscriptFeature,
  SuperscriptFeature,
  UnderlineFeature,
  UnorderedListFeature,
  lexicalEditor,
} from "@payloadcms/richtext-lexical";
import type { Block, Field } from "payload";

import { link, links } from "../fields/link";
import { sectionOptions } from "../fields/section-options";

/**
 * One block per section type in @launch/content-model, with the same slugs and
 * field names. Each block's content and its section options sit on separate
 * tabs, so the content leads in the admin.
 */

/**
 * A block's fields on a Content tab and its section options on an Options
 * tab. The tabs are unnamed, so the stored data keeps its shape.
 */
const tabbed = (fields: Field[]): Field[] => [
  {
    tabs: [
      { fields, label: "Content" },
      { fields: [sectionOptions], label: "Options" },
    ],
    type: "tabs",
  },
];

const eyebrow = { name: "eyebrow", type: "text" } as const;
const heading = { name: "heading", type: "text" } as const;

/**
 * Section bodies offer only what @launch/adapter-payload's Lexical renderer
 * draws. The default editor also allows uploads, relationships and blocks,
 * which would save but never reach the page.
 */
export const sectionBodyEditor = lexicalEditor({
  features: () => [
    ParagraphFeature(),
    HeadingFeature({ enabledHeadingSizes: ["h2", "h3", "h4"] }),
    BoldFeature(),
    ItalicFeature(),
    UnderlineFeature(),
    StrikethroughFeature(),
    InlineCodeFeature(),
    SubscriptFeature(),
    SuperscriptFeature(),
    LinkFeature({ enabledCollections: ["pages"] }),
    UnorderedListFeature(),
    OrderedListFeature(),
    BlockquoteFeature(),
    HorizontalRuleFeature(),
    FixedToolbarFeature(),
    InlineToolbarFeature(),
  ],
});

const body = {
  editor: sectionBodyEditor,
  name: "body",
  type: "richText",
} as const;

const upload = (name: string, required = false) =>
  ({ name, relationTo: "media", required, type: "upload" }) as const;

export const Content: Block = {
  fields: tabbed([
    eyebrow,
    heading,
    body,
    {
      defaultValue: "start",
      name: "align",
      options: ["start", "center"],
      type: "select",
    },
    links,
  ]),
  interfaceName: "ContentSection",
  slug: "content",
};

export const ContentMedia: Block = {
  fields: tabbed([
    eyebrow,
    heading,
    body,
    upload("media", true),
    {
      defaultValue: "end",
      name: "mediaPosition",
      options: ["start", "end"],
      type: "select",
    },
    links,
  ]),
  interfaceName: "ContentMediaSection",
  slug: "contentMedia",
};

export const MediaSection: Block = {
  fields: tabbed([upload("media", true)]),
  // The default name, `Media`, would clash with the media collection's type.
  interfaceName: "MediaSection",
  labels: { plural: "Media", singular: "Media" },
  slug: "media",
};

export const CardGrid: Block = {
  fields: tabbed([
    heading,
    {
      defaultValue: "3",
      name: "columns",
      options: ["2", "3", "4"],
      required: true,
      type: "select",
    },
    {
      fields: [
        { name: "title", required: true, type: "text" },
        { name: "text", type: "textarea" },
        upload("image"),
        link("link", { variant: false }),
      ],
      name: "cards",
      type: "array",
    },
  ]),
  interfaceName: "CardGridSection",
  slug: "cardGrid",
};

export const Blockquote: Block = {
  fields: tabbed([
    { name: "quote", required: true, type: "textarea" },
    { name: "attribution", type: "text" },
    { name: "role", type: "text" },
    upload("image"),
  ]),
  interfaceName: "BlockquoteSection",
  slug: "blockquote",
};

export const CallToAction: Block = {
  fields: tabbed([{ ...heading, required: true }, body, links]),
  interfaceName: "CallToActionSection",
  slug: "callToAction",
};

export const FormSection: Block = {
  fields: tabbed([
    heading,
    body,
    {
      admin: {
        description: "Build forms under Forms in the sidebar.",
      },
      name: "form",
      relationTo: "forms",
      required: true,
      type: "relationship",
    },
  ]),
  // The default name, `Form`, would clash with the forms collection's type.
  interfaceName: "FormSection",
  labels: { plural: "Forms", singular: "Form" },
  slug: "form",
};

export const sectionBlocks = [
  Content,
  ContentMedia,
  MediaSection,
  CardGrid,
  Blockquote,
  CallToAction,
  FormSection,
];
