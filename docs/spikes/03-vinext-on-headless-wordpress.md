# Spike 3: vinext front-end on headless WordPress over WPGraphQL

Issue: #4. Apps: [`apps/cms-wordpress-headless`](../../apps/cms-wordpress-headless) and [`apps/web-wordpress`](../../apps/web-wordpress).

**Answer:** it works end to end locally. A vinext 1.4 App Router app reads a Docker WordPress over WPGraphQL with generated types, caches pages until WordPress publishes, and previews drafts and unsaved changes. Nothing needed a workaround in vinext itself. The surprises were on the WordPress side: where the plugins come from, and a WPGraphQL 2 breaking change to preview queries.

## What was built

- **WordPress** (`apps/cms-wordpress-headless`): `wordpress:php8.3-apache` and MariaDB in Docker Compose, WP-CLI as a profile. Composer (run in its own image, so the host needs only Docker) installs WPGraphQL 2.25.0, WPGraphQL for ACF 3.0.0 and ACF 6.8.10 (free) into the gitignored `wp-content/plugins/`. Committed code is only ours: the `patronage-headless` theme (menu, Hero field group in PHP, preview links, redirect to the front-end) and the `patronage-headless-revalidate` mu-plugin. `bin/setup.sh` installs, seeds invented content and writes the front-end's `.env.local`; it is safe to rerun.
- **Front-end** (`apps/web-wordpress`): vinext 1.4.0 on Vite 8 and React 19.3, Node target. One catch-all route renders pages and posts by URI, a `/preview/[id]` route renders drafts in draft mode, and three route handlers serve revalidation, preview entry and preview exit. Queries are typed with GraphQL Code Generator's client preset against a committed `schema.graphql`.
- The queries start from the existing headless starter (content by URI, menu, post fields). Its Yoast SEO and Redirection queries are left out because those plugins are not installed here.

## What was verified

All on a production build (`vite build`, then `vinext start`) against the Docker WordPress:

| Check | Result |
| --- | --- |
| Home, page, post, 404 and trailing-slash redirect | 200, 200, 200, 404, 308 |
| ACF Hero fields (text, textarea, link) over WPGraphQL | rendered |
| ISR | first request `x-vinext-cache: MISS`, then `HIT` |
| A database edit that bypasses WordPress hooks | stays stale, as expected |
| Publishing an edit in WordPress | the mu-plugin's PUT revalidates and the next request shows it |
| `wp patronage-headless-revalidate verify` (publish, edit, trash a test post) | passes: 200 with the title, 200 with the edit, 404 after trash |
| Revalidate with a wrong secret | 401 |
| Preview of a draft and of a published page's autosave | renders the draft and the unsaved body |
| Preview without draft mode, or with a tampered or expired token | 404, 401, 401 |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | pass (tests cover the preview token) |

## Findings

1. **Install WPGraphQL from its GitHub release zips, not Packagist.** WPGraphQL moved to a monorepo (`wp-graphql/wp-graphql`, with tags like `wp-graphql/v2.25.0` and `wp-graphql-acf/v3.0.0`). Its Packagist package stopped at 2.6.0 in January 2026, installs from source without built assets, and conflicts with WPGraphQL for ACF on `appsero/client` (2.0.5 against 1.2.1). The release zips are self-contained (their own `vendor/`), so `composer.json` declares them as `package` repositories. ACF (free) comes from its official GitHub repository, which has a `composer.json`. WPackagist would also work, but it adds a wordpress.org dependency for no gain here. ACF Pro would need its licensed Composer repository; the demo uses free field types only.
2. **WPGraphQL 2 removed `asPreview`.** The starter's `page(id:, asPreview: true)` queries fail validation. Unsaved changes are now the latest revision, reached with `contentNode(id:, idType: DATABASE_ID) { ... on Page { preview { node { … } } } }`. The front-end takes the fields from the revision and the ID, URI and status from the post.
3. **Application passwords replace the JWT plugin.** WPGraphQL accepts WordPress application passwords over HTTP Basic auth, so drafts are read as a dedicated `previewer` editor and no auth plugin is needed. WPGraphQL also refuses introspection to anonymous users by default, so `codegen:schema` uses the same password. The committed schema snapshot means CI and type checks never need a running WordPress.
4. **Preview links are signed, not secret.** The starter put the shared secret in the Preview URL, where every editor could copy it. The theme now issues `base64url(id.expires).base64url(HMAC-SHA256)` tokens that last 10 minutes and name one post. The front-end checks them with Web Crypto, so the check also runs on Workers.
5. **vinext's caching follows Next 16.** `fetch(…, { next: { tags } })`, `revalidateTag(tag, { expire: 0 })` and `revalidatePath()` all behave as in Next.js. A path without its trailing slash (`/about`, which the mu-plugin sends) revalidates `/about/`. Two details matter:
   - The build report marks a dynamic route `ƒ` (dynamic) unless it exports `revalidate`. With `export const revalidate = 3600` it is `◐` (ISR) and caches; on-demand revalidation does the real work and the timer is a fallback.
   - Keep `draftMode()` out of the shared layout. The preview banner lives on the preview route, so public pages stay cacheable.
6. **The revalidation mu-plugin ports cleanly.** It is Patronage's existing plugin with one wire format left (PUT `{paths, tags}` with `X-Headless-Secret-Key`) and the Vercel bypass removed. Its Cloudflare Access service-token headers stay, for a front-end behind Access.

## Not covered, and where it goes next

- **Workers (Spike 1).** This ran on vinext's Node server only. On Workers, the in-memory cache has to become a shared one (the KV data adapter, plus the Workers Cache CDN adapter so `revalidatePath` purges the edge), or a revalidation reaches only one isolate. `lib/wordpress/env.ts` reads `process.env` per request; check that Worker secrets appear there, or read them from `cloudflare:workers`.
- **Cloudflare Access in front of WordPress.** GraphQL requests from the Worker will need an Access service token (`CF-Access-Client-Id` and `-Secret` headers) next to, or instead of, the application password. The revalidation side already supports Access.
- **Spike 2.** `components/content-view.tsx` renders WPGraphQL data directly. The WordPress adapter should map `ContentFields` to `packages/content-model`; block HTML stays WordPress-specific and is passed to `packages/ui` as children.
- **Not ported from the starter:** SEO metadata (Yoast plus its GraphQL extension), redirects (the starter's middleware called the Redirection plugin's REST API on every request), and `next/image` with WordPress media.

## Gotchas

- Bind mounts point at directories, so a branch switch that replaces the theme or mu-plugins folder leaves the container with an empty mount. `docker compose up -d --force-recreate wordpress` fixes it.
- The WP-CLI image runs as uid 82 and the Apache image as uid 33; the `cli` service runs as 33 so both can write the same files.
- WordPress 6.7+ logs a `_load_textdomain_just_in_time` notice for WPGraphQL and WPGraphQL for ACF on every WP-CLI call. It is harmless noise.
