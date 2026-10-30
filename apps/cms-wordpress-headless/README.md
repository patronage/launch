# cms-wordpress-headless

WordPress as an editing tool and a GraphQL API for [`apps/web-wordpress`](../web-wordpress). It runs locally in Docker; nothing here renders the public site.

## What is in git

- `composer.json` and `composer.lock`: WPGraphQL, WPGraphQL Smart Cache, WPGraphQL for ACF, [Secure Custom Fields](https://github.com/WordPress/secure-custom-fields), [Extended ACF](https://github.com/vinkla/extended-acf) and [Extended CPTs](https://github.com/johnbillion/extended-cpts). Composer installs them into `wp-content/plugins/`, which is gitignored.
- `wp-content/themes/patronage-headless/`: registers the primary menu, the ACF field groups in `fields/` (see [Fields](#fields)) and post types with their admin list columns in `inc/post-types.php`, points the editor's Preview button at the front-end with a signed link, redirects visitors of WordPress's own front-end to the headless site, and locks WPGraphQL to the front-end's registered queries (`inc/persisted-queries.php`, `graphql-documents.json`).
- `wp-content/mu-plugins/patronage-headless-revalidate.php`: tells the front-end which paths and tags to revalidate when content is published, edited, moved, unpublished or trashed.
- `bin/setup.sh` and `bin/seed.sh`: install, configure and seed invented demo content (`seed/seed.php`, with images from [`packages/demo-content`](../../packages/demo-content)).

## Run it

Needs only Docker: Composer runs in its official image (`pnpm --filter cms-wordpress-headless composer -- update` to change plugin versions).

```sh
pnpm --filter cms-wordpress-headless setup   # composer install, start Docker, install and seed WordPress
pnpm --filter web-wordpress dev              # front-end on http://localhost:3000
```

`setup` is safe to rerun. It creates `.env` (gitignored) with a fresh `HEADLESS_SECRET`, and writes `apps/web-wordpress/.env.local` with the same secret and a new application password for the `previewer` editor.

- Admin: http://localhost:8080/wp-admin/ (`admin` / `admin`, local only)
- GraphQL: http://localhost:8080/graphql
- WP-CLI: `pnpm --filter cms-wordpress-headless wp -- <command>`
- GraphQL as an administrator: the GraphiQL IDE in wp-admin. Signed-out callers can run only registered queries, by ID.
- Reseed (adds missing pages, leaves existing ones alone): `pnpm --filter cms-wordpress-headless seed`
- Stop, or wipe the database: `pnpm --filter cms-wordpress-headless stop` / `reset`

## Fields

Field groups are PHP files in `wp-content/themes/patronage-headless/fields/`, written with Extended ACF's field classes and loaded on `acf/init`. ACF's JSON sync is off, so editing a field group in wp-admin changes nothing; change the PHP instead.

- **Hero** (`hero.php`, pages and posts): eyebrow, headline, intro and a call to action.
- **Page Builder** (`page-builder.php`, pages): the flexible content field `sections`, with one layout per block in [`packages/content-model`](../../packages/content-model): `content`, `content_media`, `media`, `card_grid`, `blockquote` and `call_to_action`. Each layout has a "Section options" tab (`skin`, `width`, `padding_top`, `padding_bottom`, `anchor`, `hidden`). Names follow the content model and the Payload app's blocks, so [`packages/adapter-wordpress`](../../packages/adapter-wordpress) only maps rich text, links and images. Pages hide the block editor: their content is their sections.

WPGraphQL for ACF exposes the group as `pageBuilder { sections { ... } }`, with one type per layout (`PageBuilderSectionsCardGridLayout`). Choices are button groups, which come back as plain strings. After changing fields, refresh the front-end's schema snapshot with `pnpm --filter web-wordpress codegen:schema`.

Secure Custom Fields is the GPL fork of ACF that includes the field types the Page Builder needs (flexible content, repeater). ACF Pro works the same way if you have a license: swap the Composer package.

## How the pieces connect

| Concern | WordPress side | Front-end side |
| --- | --- | --- |
| Content | WPGraphQL at `/graphql` | `lib/wordpress/client.ts`, typed by codegen |
| Revalidation | mu-plugin sends `PUT /api/revalidate/` with `{paths, tags}` and `X-Headless-Secret-Key`; the theme adds every key Smart Cache purges as a tag (`inc/cache-tags.php`) | reads are tagged with their `X-GraphQL-Keys` (`lib/wordpress/cache-tags.ts`); `app/api/revalidate/route.ts` calls `revalidateTag` and `revalidatePath` |
| Locked queries | Smart Cache in "only allowed" mode; the theme registers `graphql-documents.json` on the next request after it changes, or with `wp patronage-headless documents` | requests send only `{queryId, variables}`; `pnpm --filter web-wordpress documents` writes the manifest |
| Preview | theme rewrites the Preview link to `/api/preview/?token=…`, an HMAC of the post ID and an expiry | `app/api/preview/route.ts` checks it, enables draft mode, renders `/preview/<id>/` with the application password and the `X-GraphQL-Preview` header |

### Cache tags

The front-end caches each WPGraphQL read under the WPGraphQL Smart Cache keys in its `X-GraphQL-Keys` header: the global ID of every post, term, menu item, user and settings group it used, plus `list:<type>` keys. Pages carry the tags of the reads they render. When something changes, Smart Cache purges its keys (`graphql_purge`), and `inc/cache-tags.php` queues each one with the mu-plugin. So editing one page expires that page and any page that shows it (a card linking to it, an image it uses), and leaves the rest cached. A menu change expires every page, because every page renders the menu.

- `graphql:Query` and "Purge Cache Now" go out as `wordpress`, the tag on every read.
- Each changed post's paths still go out too. The front-end expires the content read for each path, which is what replaces a cached "not found" when a post is published at that URL.
- Smart Cache's own object cache is turned off. A response it serves from there carries no node keys, and the front-end only asks WordPress on a miss anyway.
- Settings changes purge only options registered with `register_setting()`. WordPress registers its own on admin and REST requests; the theme does it for WP-CLI too.

Check the revalidation round trip against a running front-end (it publishes, edits and trashes a test post, and reports how long each change took to show):

```sh
pnpm --filter cms-wordpress-headless wp -- patronage-headless-revalidate verify
```

Each check retries for up to `--wait` seconds (90 by default). On Workers, KV caches what it reads in each location, so a change can take a few seconds to show where the purge landed and up to about a minute elsewhere.

When WordPress runs in Docker it reaches the front-end at `HEADLESS_FRONTEND_INTERNAL_URL` (default `http://host.docker.internal:3000`), so the front-end listens on port 3000 on all interfaces (`pnpm --filter web-wordpress start` already does) and allows that host name (`vite.config.ts`).

## Gotchas

- The theme, mu-plugins and plugins folders are bind-mounted. If git replaces one of those directories (switching branches), the container keeps the old, now empty, mount: run `docker compose up -d --force-recreate wordpress`.
- WP-CLI runs as uid 33 (the Apache image's `www-data`), not the CLI image's default uid 82, so files it writes stay writable by WordPress.
- Composer downloads everything from GitHub. The ACF and `composer/installers` zips come from GitHub's API, which allows 60 unauthenticated requests an hour; if you hit that, pass a token with `COMPOSER_DOCKER_ARGS='-e COMPOSER_AUTH={"github-oauth":{"github.com":"<token>"}}'`. The same variable can mount a proxy's CA bundle.
