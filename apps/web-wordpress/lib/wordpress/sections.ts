import { createWordPressAdapter } from "@launch/adapter-wordpress";
import type { Page } from "@launch/content-model";
import { imagePath } from "@launch/images";
import type { ReactNode } from "react";

import type { Content } from "./content";
import { wordpressEnv } from "./env";

/** Where WordPress keeps uploads; app/media serves them through Cloudflare Images. */
export const UPLOADS_PATH = "/wp-content/uploads/";

/**
 * Maps a page's Page Builder sections to the shared content model, or
 * returns undefined for posts and for pages without sections.
 */
export const toSectionsPage = (
  content: Content
): Page<ReactNode> | undefined => {
  if (content.__typename !== "Page" || !content.pageBuilder?.sections?.length) {
    return undefined;
  }

  const { origin } = wordpressEnv();

  const adapter = createWordPressAdapter({
    cmsOrigin: origin,
    imageUrl: (src) => imagePath(src, `${origin}${UPLOADS_PATH}`),
  });

  return adapter.toPage({ data: { page: content } });
};
