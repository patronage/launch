# SEO and redirects

What search engines and visitors get from Payload's SEO fields and redirects. The web-wordpress front end doesn't have these yet.

## Sub-features

- `metadata`: a page's title, description, canonical URL and social image, in `<head>`.
- `noindex`: **Hide from search engines** adds a robots meta tag and drops the page from the sitemap.
- `sitemap`: `/sitemap.xml` lists published pages and posts, and leaves out drafts.
- `robots`: `/robots.txt` points to the sitemap and disallows the CMS paths.
- `redirects`: an old path answers 308 or 307. A published page beats a redirect, and a redirect to a draft or to itself is ignored.
- `editing`: an editor adds a redirect in the admin and edits a page's SEO group.

## How to get to it (user POV)

- A direct visit to an old address, such as `/seeds` or `/2024/05/tool-library/`.
- **Redirects** in the admin sidebar, and the **SEO** group at the bottom of a page or post.
- A crawler reading `/robots.txt` and `/sitemap.xml`.

## Driving it with verify.ts

Preconditions: Payload is launched and seeded, Doctor passes, and a local admin exists (`drive payload apply-form` creates one on a fresh database).

`node .agents/skills/launch-verify/scripts/verify.ts drive payload seo` covers every sub-feature. It saves `sitemap.xml` with its evidence and deletes the redirects it adds.

## Gotchas

- `Location` headers are relative for paths on the site.
- A reseed resets the SEO text and the seeded redirects.
