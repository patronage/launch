import type { PopulateType } from "payload";

/**
 * How the front end reads a page, shared with scripts/record-fixture.ts so
 * the adapter's fixture is exactly what the route gets. Depth 1 populates
 * uploads and linked pages; `populate` trims linked pages to what a link
 * needs, instead of their whole layout.
 */
export const PAGE_QUERY = {
  depth: 1,
  populate: {
    pages: { breadcrumbs: true, slug: true, title: true },
  } satisfies PopulateType,
} as const;
