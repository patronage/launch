import { seoPlugin } from "@payloadcms/plugin-seo";
import type { GenerateURL } from "@payloadcms/plugin-seo/types";

import { postPath } from "./lib/posts";
import { payloadAdapter } from "./lib/sections";

const generateURL: GenerateURL = ({ collectionSlug, doc, req }) => {
  const path =
    collectionSlug === "posts" ? postPath(doc) : payloadAdapter.pagePath(doc);

  return new URL(path ?? "/", req.url).href;
};

/**
 * The SEO group on pages and posts: a title, description and social image
 * that override what the front end would otherwise derive from the document
 * (lib/seo.ts), and a switch to keep the document out of search engines.
 */
export const seo = () =>
  seoPlugin({
    collections: ["pages", "posts"],
    fields: ({ defaultFields }) => [
      ...defaultFields,
      {
        admin: {
          description:
            "Tells search engines not to index this page and leaves it out of the sitemap.",
        },
        defaultValue: false,
        label: "Hide from search engines",
        name: "noindex",
        type: "checkbox",
      },
    ],
    generateDescription: ({ doc }) => doc.excerpt ?? "",
    generateImage: ({ doc }) => doc.hero?.image ?? doc.hero ?? "",
    generateTitle: async ({ doc, req }) => {
      const { siteName } = await req.payload.findGlobal({
        req,
        slug: "site-settings",
      });

      return `${doc.title} | ${siteName}`;
    },
    generateURL,
    interfaceName: "SeoMeta",
    uploadsCollection: "media",
  });
