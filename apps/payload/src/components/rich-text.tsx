import type { PayloadRichTextBlock } from "@launch/adapter-payload";
import { Img, RichTextBlock } from "@launch/ui";
import type { SerializedEditorState } from "@payloadcms/richtext-lexical/lexical";
import type { JSXConvertersFunction } from "@payloadcms/richtext-lexical/react";
import { LinkJSXConverter, RichText } from "@payloadcms/richtext-lexical/react";

import { postPath } from "@/lib/posts";
import { payloadAdapter, toImage } from "@/lib/sections";
import type { Media, Page, Post } from "@/payload-types";

type LinkNode = Parameters<
  NonNullable<Parameters<typeof LinkJSXConverter>[0]["internalDocToHref"]>
>[0]["linkNode"];

/**
 * The path an internal link points to. Read at depth 1, the linked document
 * is populated; an id alone means it was not, so the link has no address.
 */
const internalHref = ({ linkNode }: { linkNode: LinkNode }): string => {
  const { doc } = linkNode.fields;

  if (!(doc?.value instanceof Object)) {
    return "#";
  }

  if (doc.relationTo === "posts") {
    // SAFETY: relationTo names the collection the populated value came from.
    return postPath(doc.value as Partial<Pick<Post, "slug">>) ?? "#";
  }

  if (doc.relationTo === "pages") {
    return (
      payloadAdapter.pagePath(
        // SAFETY: relationTo names the collection the populated value came from.
        doc.value as Pick<Page, "id"> &
          Partial<Pick<Page, "breadcrumbs" | "slug">>
      ) ?? "#"
    );
  }

  // Other collections have no page of their own.
  return "#";
};

/** Draws a rich-text block through the adapter's mapping, as section bodies do. */
const block = ({ node }: { node: { fields: object } }) => {
  // SAFETY: Payload stores a block's fields under the block config in
  // rich-text/blocks.ts, which PayloadRichTextBlock mirrors.
  const found = payloadAdapter.richTextBlock(
    node.fields as PayloadRichTextBlock
  );

  return found ? <RichTextBlock block={found} /> : null;
};

/** Rich text is at most max-w-3xl (48rem) wide. */
const RICH_TEXT_IMAGE_SIZES = "(min-width: 48rem) 48rem, 100vw";

const converters: JSXConvertersFunction = ({ defaultConverters }) => ({
  ...defaultConverters,
  ...LinkJSXConverter({ internalDocToHref: internalHref }),
  blocks: { embed: block, image: block, pullquote: block },
  inlineBlocks: { button: block },
  // Uploaded images go through the media route at the width the reader
  // needs, as section images do. Other files link to Payload's file URL, as
  // Payload's own converter does.
  upload: ({ node }) => {
    // SAFETY: uploads in rich text can only come from the media collection;
    // at depth 1 the value is its document, and an id means it wasn't read.
    const media = node.relationTo === "media" ? (node.value as Media) : null;

    if (!(media instanceof Object && media.url)) {
      return null;
    }

    const image = media.mimeType?.startsWith("image/")
      ? toImage(media)
      : undefined;

    return image ? (
      <Img image={image} sizes={RICH_TEXT_IMAGE_SIZES} />
    ) : (
      <a href={media.url} rel="noopener noreferrer">
        {media.filename}
      </a>
    );
  },
});

/** Payload's rich text renderer, with internal links resolved to paths. */
export const PayloadRichText = ({ data }: { data: SerializedEditorState }) => (
  <RichText converters={converters} data={data} />
);
