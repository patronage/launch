/**
 * News routes and queries. Stories live at /news/{slug}; the listing, and
 * each category's and tag's archive, at /news, /news/category/{slug} and
 * /news/tag/{slug}, with older pages at .../page/{n}.
 */
import type {
  EmDashCategoryDetailsData,
  EmDashImage,
  EmDashNewsData,
} from "@launch/adapter-emdash";
import { categoryPath, NEWS_PATH, tagPath } from "@launch/adapter-emdash";
import { getEmDashCollection } from "emdash";

/** Stories per listing page: two rows of three. */
export const PAGE_SIZE = 6;

export type NewsFilter =
  | { kind: "all" }
  | { kind: "category"; slug: string }
  | { kind: "tag"; slug: string };

export type NewsRoute =
  | { kind: "listing"; filter: NewsFilter; page: number }
  | { kind: "story"; slug: string }
  | { kind: "redirect"; to: string }
  | { kind: "missing" };

const PAGE_NUMBER = /^[1-9]\d{0,5}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;

/** A listing's first page, without `/page/1`. */
export const filterPath = (filter: NewsFilter): string => {
  if (filter.kind === "category") {
    return categoryPath(filter.slug);
  }

  return filter.kind === "tag" ? tagPath(filter.slug) : NEWS_PATH;
};

/** The URL of one page of a listing. */
export const listingPath = (filter: NewsFilter, page: number): string =>
  page <= 1 ? filterPath(filter) : `${filterPath(filter)}/page/${page}`;

/** Where a listing page is, given the path after /news/ split on slashes. */
const listingRoute = (filter: NewsFilter, rest: string[]): NewsRoute => {
  if (rest.length === 0) {
    return { filter, kind: "listing", page: 1 };
  }

  const [word, number] = rest;

  if (
    rest.length !== 2 ||
    word !== "page" ||
    !number ||
    !PAGE_NUMBER.test(number)
  ) {
    return { kind: "missing" };
  }

  const page = Number(number);

  // /page/1 is the first page under a second URL.
  return page === 1
    ? { kind: "redirect", to: filterPath(filter) }
    : { filter, kind: "listing", page };
};

/** Parses the path after /news/ (empty for /news itself). */
export const parseNewsPath = (path: string | undefined): NewsRoute => {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const [first, second, ...rest] = segments;

  if (!first || first === "page") {
    return listingRoute({ kind: "all" }, segments);
  }

  if (first === "category" || first === "tag") {
    return second && SLUG.test(second)
      ? listingRoute({ kind: first, slug: second }, rest)
      : { kind: "missing" };
  }

  return segments.length === 1 && SLUG.test(first)
    ? { kind: "story", slug: first }
    : { kind: "missing" };
};

/** One page of published stories, newest first. */
export const getNewsPage = async (filter: NewsFilter, page: number) => {
  const query: Parameters<typeof getEmDashCollection>[1] = {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    orderBy: { published_at: "desc" },
    status: "published",
  };

  if (filter.kind !== "all") {
    query.where = { [filter.kind]: filter.slug };
  }

  const { entries, hasMore, cacheHint } = await getEmDashCollection<
    "news",
    EmDashNewsData
  >("news", query);

  return { cacheHint, entries, hasMore: hasMore === true };
};

/**
 * Every category's details by slug, for category images and intros. One
 * small query per render; there are few categories.
 */
export const getCategoryDetails = async (): Promise<
  Map<string, EmDashCategoryDetailsData>
> => {
  const { entries } = await getEmDashCollection<
    "category_details",
    EmDashCategoryDetailsData
  >("category_details", { limit: 100, status: "published" });

  return new Map(entries.map((entry) => [entry.id, entry.data]));
};

/** Looks up a category's image, for stories without their own. */
export const categoryImageFrom =
  (details: Map<string, EmDashCategoryDetailsData>) =>
  (slug: string): EmDashImage | null | undefined =>
    details.get(slug)?.image;
