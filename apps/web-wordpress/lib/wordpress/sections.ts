import { createWordPressAdapter } from "@launch/adapter-wordpress";
import type { Page } from "@launch/content-model";
import { imagePath } from "@launch/images";
import { RichTextBlock } from "@launch/ui";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { Content } from "./content";
import { wordpressEnv } from "./env";

/** Where WordPress keeps uploads; app/media serves them through Cloudflare Images. */
export const UPLOADS_PATH = "/wp-content/uploads/";

/** Where form sections post (with the trailing slash every route here has); app/forms/submit passes them to WordPress. */
export const FORM_ACTION = "/forms/submit/";

const adapter = () => {
  const { origin } = wordpressEnv();

  return createWordPressAdapter({
    cmsOrigin: origin,
    formAction: FORM_ACTION,
    imageUrl: (src) => imagePath(src, `${origin}${UPLOADS_PATH}`),
    renderRichTextBlock: (block) => createElement(RichTextBlock, { block }),
  });
};

/**
 * Maps a page or post's hero, and a page's Page Builder sections, to the
 * shared content model, or returns undefined when it has neither.
 */
export const toSectionsPage = (
  content: Content
): Page<ReactNode> | undefined => {
  if (content.__typename !== "Page" && content.__typename !== "Post") {
    return undefined;
  }

  // Posts have no Page Builder; the adapter reads their hero alone.
  const page = adapter().toPage({
    data: {
      page:
        content.__typename === "Page"
          ? content
          : { ...content, pageBuilder: null },
    },
  });

  return page && (page.hero || page.sections.length > 0) ? page : undefined;
};
