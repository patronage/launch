import { createPayloadAdapter } from "@launch/adapter-payload";
import type { Image } from "@launch/content-model";
import { imagePath } from "@launch/images";
import { RichTextBlock } from "@launch/ui";
import { createElement } from "react";

import type { Media } from "@/payload-types";

/** Where Payload serves uploads; app/(frontend)/media serves them resized instead. */
const MEDIA_FILES_PATH = "/api/media/file/";

/** A Payload upload URL, pointed at the image route. */
export const mediaUrl = (src: string): string =>
  imagePath(src, MEDIA_FILES_PATH);

/** Maps page documents (read at depth 1) to the shared content model. */
export const payloadAdapter = createPayloadAdapter({
  imageUrl: mediaUrl,
  renderRichTextBlock: (block) => createElement(RichTextBlock, { block }),
});

/**
 * An upload field as the UI's image, or undefined when it is empty. At depth 1
 * the field holds the Media document; a bare id means it was not populated.
 */
export const toImage = (
  media: Media | number | null | undefined
): Image | undefined => {
  if (!(media instanceof Object) || !media.url) {
    return undefined;
  }

  return {
    alt: media.alt,
    height: media.height ?? undefined,
    src: mediaUrl(media.url),
    width: media.width ?? undefined,
  };
};
