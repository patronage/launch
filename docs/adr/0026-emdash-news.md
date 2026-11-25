# ADR 0026: EmDash news with taxonomies, category details and public listing routes

## Status

Accepted, 2026-11-25. Adds to [ADR 0022](0022-emdash-renders-the-site-in-astro.md) and [ADR 0024](0024-emdash-seo-redirects-and-forms.md).

## Context

The EmDash site needs news stories with a primary category, an image per category that stands in for a story without one, tags, category and tag archives, and cards that load more in place. EmDash has collections and taxonomies, but a taxonomy term holds only a label, slug, parent and description, and a story can hold any number of terms. EmDash's content API is behind Cloudflare Access with the admin, and it answers only signed-in users anyway.

## Decision

- Stories are a `news` collection at `/news/{slug}`, with `category` and `tag` taxonomies. EmDash's admin assigns terms, and `getEmDashCollection` filters archives by term and returns each story's terms in the same query.
- A story has exactly one category, its primary one. A small native plugin in the app (`src/plugins/news-rules.ts`) refuses to publish or schedule a story with none or several. Drafts save without one, because EmDash assigns terms apart from the save. EmDash 1.6 runs no hook when terms change on a live story, so the rule holds at publish time only; the front end shows the first category by label if a story ends up with several, and no category or stand-in image if it has none.
- A `category_details` collection holds what a term can't: the category's image and intro, one entry per category with the category's slug as its own. Reference fields were ruled out: they can't filter a listing and don't load with one.
- Listings use offset pages (`/news/page/2`, `/news/category/{slug}/page/2`), which work without JavaScript. "Older stories" fetches the same URL with `?fragment=cards`, which returns only that page's cards from the same components, and appends them. The CMS API stays behind Access.
- The card is `NewsCard` in `@launch/ui`, on a CMS-neutral `NewsSummary`, so other sites can use it.

## Consequences

- Editors keep categories and their details in two places, matched by slug. A category without details shows no fallback image.
- On a live site, the new collections, taxonomies and terms are created in the admin or through its API; the seed only applies to a new database.
- The fragment is HTML, not JSON, so no client-side renderer has to match the server's.
