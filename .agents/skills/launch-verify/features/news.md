# News

A visitor reads the news. On Payload, `/news` lists published posts, featured first and then newest first, and each post is at `/news/<slug>` with its author, categories and rich text. On WordPress, posts are also served under `/news/<slug>/`.

## Sub-features

- `listing`: `/news` on Payload, with the featured post first and drafts left out.
- `post`: a single post with its rich-text blocks.
- `draft-hidden`: a draft returns 404 to a visitor.

## How to get to it (user POV)

- The **News** link in the header (Payload).
- A post card on `/news`, through to `/news/<slug>`.
- A direct visit, such as `/news/four-new-gardens-next-spring` (Payload) or `/news/hello-headless/` (WordPress).

## Driving it with verify.ts

Preconditions: the surface is launched and seeded, and Doctor passes.

- **Listing**: `node .agents/skills/launch-verify/scripts/verify.ts capture payload /news news`. The screenshot shows "Four new gardens are coming next spring" first, as the featured post.
- **Post**: `capture payload /news/how-to-save-seed post` shows the hero, byline and body. On WordPress, `capture web-wordpress /news/hello-headless/ post`.
- **Draft hidden**: `capture payload /news/hiring-youth-coordinator draft` records a 404, because that post is `draftOnly` in `apps/payload/src/seed/posts.ts`. On WordPress, the draft is the page `coming-soon`: `capture web-wordpress /coming-soon/ draft` records a 404.

## Gotchas

- A WordPress post URL ends in a slash. The front end redirects, and `capture` follows same-origin redirects.
- Seeding again resets the posts. Don't expect edits made in the admin to survive a reseed.
