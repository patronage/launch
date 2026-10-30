import { BlocksFeature } from "@payloadcms/richtext-lexical";
import type { Block } from "payload";

import { link } from "../fields/link";

/**
 * Blocks an editor can place in rich text, named after `RichTextBlock` in the
 * content model package. The adapter maps their fields and @launch/ui's
 * `RichTextBlock` draws them, in section bodies and in post and page content.
 */

const Button: Block = {
  fields: [link("link")],
  interfaceName: "RichTextButton",
  slug: "button",
};

const Image: Block = {
  fields: [
    { name: "image", relationTo: "media", required: true, type: "upload" },
    {
      admin: { description: "Leave empty to use the image's own caption." },
      name: "caption",
      type: "text",
    },
  ],
  interfaceName: "RichTextImage",
  slug: "image",
};

const Pullquote: Block = {
  fields: [
    { name: "quote", required: true, type: "textarea" },
    { name: "attribution", type: "text" },
  ],
  interfaceName: "RichTextPullquote",
  slug: "pullquote",
};

const Embed: Block = {
  fields: [
    {
      admin: {
        description:
          "A YouTube or Vimeo video, or a post on X. Other URLs show as a link.",
      },
      name: "url",
      required: true,
      type: "text",
    },
    { name: "caption", type: "text" },
  ],
  interfaceName: "RichTextEmbed",
  slug: "embed",
};

/** Image, pullquote and embed between paragraphs; a button inside one. */
export const richTextBlocks = () =>
  BlocksFeature({
    blocks: [Image, Pullquote, Embed],
    inlineBlocks: [Button],
  });
