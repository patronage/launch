import type { Post } from "@/payload-types";

/** Where the news listing lives; each post is at /news/<slug>. */
export const NEWS_PATH = "/news";

/** A post's front-end path, or undefined before it has a slug. */
export const postPath = (
  doc: Partial<Pick<Post, "slug">>
): string | undefined => (doc.slug ? `${NEWS_PATH}/${doc.slug}` : undefined);

/** A post's date as readers see it, e.g. October 30, 2026. */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
