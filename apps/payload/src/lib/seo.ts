import type { Image } from "@launch/content-model";
import type { Metadata, MetadataRoute } from "next";
import { headers } from "next/headers";

import type { SeoMeta } from "@/payload-types";

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u;

/** The origin a visitor reached `host` on. Only local previews are plain http. */
export const originForHost = (host: string): string =>
  `${LOCAL_HOST.test(host) ? "http" : "https"}://${host}`;

/**
 * This request's origin. A deployed Worker answers on exactly one public
 * hostname (cloudflare.config.ts), so the request says what it is and no
 * setting can drift from it.
 */
export const siteOrigin = async (): Promise<string> => {
  const requestHeaders = await headers();

  return originForHost(requestHeaders.get("host") ?? "localhost");
};

const nonEmpty = (value: string | null | undefined): string | undefined =>
  value?.trim() ? value : undefined;

export interface DocumentSeo {
  /** Used when the editor left the SEO description empty. */
  description?: string | null;
  /** Used when the editor left the SEO image empty. */
  fallbackImage?: Image;
  image?: Image;
  meta?: SeoMeta | null;
  origin: string;
  path: string;
  siteName: string;
  title: string;
  type: "article" | "website";
}

/**
 * A document's metadata. The editor's SEO title is used as written; the
 * document's own title goes through the layout's "Title | Site" template.
 */
export const documentMetadata = ({
  description: fallbackDescription,
  fallbackImage,
  image,
  meta,
  origin,
  path,
  siteName,
  title,
  type,
}: DocumentSeo): Metadata => {
  const seoTitle = nonEmpty(meta?.title);

  const description =
    nonEmpty(meta?.description) ?? nonEmpty(fallbackDescription);

  const social = image ?? fallbackImage;
  const url = new URL(path, origin).href;

  return {
    alternates: { canonical: url },
    ...(description && { description }),
    openGraph: {
      ...(description && { description }),
      ...(social && {
        images: [{ alt: social.alt, url: new URL(social.src, origin).href }],
      }),
      siteName,
      title: seoTitle ?? title,
      type,
      url,
    },
    ...(meta?.noindex && { robots: { follow: true, index: false } }),
    title: seoTitle ? { absolute: seoTitle } : title,
  };
};

export interface SitemapDocument {
  meta?: Pick<SeoMeta, "noindex"> | null;
  path: string | undefined;
  updatedAt: string;
}

/** Sitemap entries for the documents that have a path and aren't hidden. */
export const sitemapEntries = (
  origin: string,
  documents: SitemapDocument[]
): MetadataRoute.Sitemap =>
  documents.flatMap(({ meta, path, updatedAt }) =>
    path && !meta?.noindex
      ? [{ lastModified: updatedAt, url: new URL(path, origin).href }]
      : []
  );

/** Previews and unconfigured Workers answer on workers.dev; keep those out. */
export const robotsRules = (origin: string): MetadataRoute.Robots =>
  new URL(origin).hostname.endsWith(".workers.dev")
    ? { rules: { disallow: "/", userAgent: "*" } }
    : {
        rules: {
          allow: "/",
          disallow: ["/admin/", "/api/", "/forms/", "/next/"],
          userAgent: "*",
        },
        sitemap: `${origin}/sitemap.xml`,
      };
