import type { MetadataRoute } from "next";
import { getPayload } from "payload";

import { getPayloadConfig } from "@/lib/payload-config";
import { NEWS_PATH, postPath } from "@/lib/posts";
import { payloadAdapter } from "@/lib/sections";
import { siteOrigin, sitemapEntries } from "@/lib/seo";

export const dynamic = "force-dynamic";

// Read as an anonymous visitor, so only published documents are listed.
const PUBLIC_LIST = {
  depth: 0,
  limit: 0,
  overrideAccess: false,
  pagination: false,
  user: null,
} as const;

const sitemap = async (): Promise<MetadataRoute.Sitemap> => {
  const payload = await getPayload({ config: getPayloadConfig() });
  const origin = await siteOrigin();

  const [pages, posts] = await Promise.all([
    payload.find({
      ...PUBLIC_LIST,
      collection: "pages",
      select: {
        breadcrumbs: true,
        meta: { noindex: true },
        slug: true,
        updatedAt: true,
      },
    }),
    payload.find({
      ...PUBLIC_LIST,
      collection: "posts",
      select: { meta: { noindex: true }, slug: true, updatedAt: true },
    }),
  ]);

  return [
    { url: new URL(NEWS_PATH, origin).href },
    ...sitemapEntries(origin, [
      ...pages.docs.map((page) => ({
        meta: page.meta,
        path: payloadAdapter.pagePath(page),
        updatedAt: page.updatedAt,
      })),
      ...posts.docs.map((post) => ({
        meta: post.meta,
        path: postPath(post),
        updatedAt: post.updatedAt,
      })),
    ]),
  ];
};

export default sitemap;
