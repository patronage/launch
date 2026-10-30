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

/**
 * Maps a page's hero and Page Builder sections to the shared content model,
 * or returns undefined for posts and for pages with neither.
 */
export const toSectionsPage = (
  content: Content
): Page<ReactNode> | undefined => {
  if (content.__typename !== "Page") {
    return undefined;
  }

  const { origin } = wordpressEnv();

  const adapter = createWordPressAdapter({
    cmsOrigin: origin,
    formAction: FORM_ACTION,
    imageUrl: (src) => imagePath(src, `${origin}${UPLOADS_PATH}`),
    renderRichTextBlock: (block) => createElement(RichTextBlock, { block }),
  });

  const page = adapter.toPage({ data: { page: content } });

  return page && (page.hero || page.sections.length > 0) ? page : undefined;
};
