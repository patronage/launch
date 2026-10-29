import type { Block } from "payload";

import { link, links } from "../fields/link";
import { sectionOptions } from "../fields/section-options";

/**
 * One block per section type in @launch/content-model, with the same slugs and
 * field names. `sectionOptions` comes last so the content leads in the admin.
 */

const eyebrow = { name: "eyebrow", type: "text" } as const;
const heading = { name: "heading", type: "text" } as const;
const body = { name: "body", type: "richText" } as const;

const upload = (name: string, required = false) =>
  ({ name, relationTo: "media", required, type: "upload" }) as const;

export const Content: Block = {
  fields: [
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
    sectionOptions,
  ],
  interfaceName: "ContentSection",
  slug: "content",
};

export const ContentMedia: Block = {
  fields: [
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
    sectionOptions,
  ],
  interfaceName: "ContentMediaSection",
  slug: "contentMedia",
};

export const MediaSection: Block = {
  fields: [upload("media", true), sectionOptions],
  // The default name, `Media`, would clash with the media collection's type.
  interfaceName: "MediaSection",
  labels: { plural: "Media", singular: "Media" },
  slug: "media",
};

export const CardGrid: Block = {
  fields: [
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
    sectionOptions,
  ],
  interfaceName: "CardGridSection",
  slug: "cardGrid",
};

export const Blockquote: Block = {
  fields: [
    { name: "quote", required: true, type: "textarea" },
    { name: "attribution", type: "text" },
    { name: "role", type: "text" },
    upload("image"),
    sectionOptions,
  ],
  interfaceName: "BlockquoteSection",
  slug: "blockquote",
};

export const CallToAction: Block = {
  fields: [{ ...heading, required: true }, body, links, sectionOptions],
  interfaceName: "CallToActionSection",
  slug: "callToAction",
};

export const sectionBlocks = [
  Content,
  ContentMedia,
  MediaSection,
  CardGrid,
  Blockquote,
  CallToAction,
];
