# cms-wordpress-headless

WordPress as an editing tool and a GraphQL API for [`apps/web-wordpress`](../web-wordpress). It runs locally in Docker; nothing here renders the public site.

## What is in git

- `composer.json` and `composer.lock`: WPGraphQL, WPGraphQL Smart Cache, WPGraphQL for ACF, [Secure Custom Fields](https://github.com/WordPress/secure-custom-fields), [Formidable Forms](https://wordpress.org/plugins/formidable/), [Extended ACF](https://github.com/vinkla/extended-acf) and [Extended CPTs](https://github.com/johnbillion/extended-cpts). Composer installs them into `wp-content/plugins/`, which is gitignored.
- `wp-content/mu-plugins/patronage-fields.php`: loads what this install shares with the Timber install from [`wordpress-shared/patronage-fields`](../../wordpress-shared/patronage-fields): the ACF field groups (see [Fields](#fields)), post types with their admin list columns, the rich-text block shortcodes, and the form model and entry checks (see [Forms](#forms)).
- `wp-content/themes/patronage-headless/`: registers the primary menu, the form section's GraphQL type and submissions route (`inc/forms-api.php`), points the editor's Preview button at the front-end with a signed link, redirects visitors of WordPress's own front-end to the headless site, and locks WPGraphQL to the front-end's registered queries (`inc/persisted-queries.php`, `graphql-documents.json`).
- `wp-content/mu-plugins/patronage-headless-revalidate.php`: tells the front-end which paths and tags to revalidate when content is published, edited, moved, unpublished or trashed.
- `_build/`: deploys to Cloudways with [wp-deploy](../../wordpress-shared/wp-deploy/README.md), and a sample `wp-config.php` block for hosted environments. See [`_build/README.md`](_build/README.md).
- `bin/setup.sh` and `bin/seed.sh`: install, configure and seed invented demo content (`wordpress-shared/patronage-fields/seed/seed.php`, shared with the Timber install, with images from [`packages/demo-content`](../../packages/demo-content)): the same Neighborhood Growers pages, heroes, forms and rich-text blocks as the Payload seed, plus an about page, a post and a draft.

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

Field groups are PHP files in [`wordpress-shared/patronage-fields/fields/`](../../wordpress-shared/patronage-fields), shared with [`apps/cms-wordpress-timber`](../cms-wordpress-timber), written with Extended ACF's field classes and loaded on `acf/init` after the shared builders in `field-helpers.php`. ACF's JSON sync is off, so editing a field group in wp-admin changes nothing; change the PHP instead.

- **Hero** (`hero.php`, pages and posts): `Hero` in the content model. A `variant` (`home`, `split`, `media`, `simple` or `freeform`; empty for no hero), then `title` (defaults to the page title), `eyebrow`, `skin`, `align`, `subhead`, `image`, `links`, and a rich-text `body` for `freeform`. Each variant shows only the fields it draws. A page without a hero opens with its first section's heading as the `<h1>`, and a post with its title. Heroes saved with the earlier fields (headline, intro, call to action) move to a simple hero once, on the first request after the update.
- **Page Builder** (`page-builder.php`, pages): the flexible content field `sections`, with one layout per block in [`packages/content-model`](../../packages/content-model): `content`, `content_media`, `media`, `card_grid`, `blockquote`, `call_to_action` and `form`. Each layout has a "Section options" tab (`skin`, `width`, `padding_top`, `padding_bottom`, `anchor`, `hidden`). Names follow the content model and the Payload app's blocks, so [`packages/adapter-wordpress`](../../packages/adapter-wordpress) only maps rich text, links and images. Pages hide the block editor: their content is their sections.

### Rich-text blocks

Rich-text fields (section bodies, the free-form hero) take the content model's rich-text blocks as shortcodes, the TinyMCE counterpart of the Payload editor's blocks:

```text
[launch_button url="/apply/" label="Apply now" variant="primary" new_tab="1"]
[launch_image id="12" caption="Leave out to use the image's own caption"]
[launch_pullquote attribution="Rosa Delgado"]Test first, plant second.[/launch_pullquote]
[launch_embed url="https://www.youtube.com/watch?v=…" caption="A YouTube or Vimeo video, or a post on X"]
```

A button can sit inside a paragraph; the others go on a line of their own. WPGraphQL for ACF runs rich text through `the_content`, which turns each shortcode into an empty element holding the block as JSON (`data-launch-block`), and the adapter draws it with `RichTextBlock` from `@launch/ui`. The shared shortcodes also turn off `wptexturize`, so rich text keeps the straight quotes the editor typed, as Payload's does.

### Forms

[Formidable Forms](https://wordpress.org/plugins/formidable/) (free) holds each form: its fields, the submit button's label (Settings › Buttons) and the success message, and it stores the entries. A Page Builder `form` section picks a form by ID. `wordpress-shared/patronage-fields/forms.php` shapes the form and checks submissions for both installs, and this theme's `inc/forms-api.php`:

- expires every front-end page when a form changes (the `wordpress` tag, as a menu change does), since pages read their form when they render.
- exposes it to WPGraphQL as `form` on the section (`PatronageForm`, shaped after `Form` in the content model). Text, email, paragraph, number, dropdown, checkbox and HTML fields map to the content model's field types, and Formidable's layout classes (`frm_half`, `frm_third`, …) to widths. A checkbox field is one box, labelled with the field's name. A field submits under its field key, less its form's key and an underscore (`volunteer_email` submits as `email`), since keys are unique across forms.
- takes submissions at `POST /wp-json/patronage/v1/forms/<id>/submissions`, `{ values }` as JSON with `X-Headless-Secret-Key`. Only the front-end knows the secret: it posts there from `apps/web-wordpress/app/forms/submit`. The route keeps only the form's own fields, checks required fields, emails, numbers, dropdown options and checkboxes (`"true"` or `"false"`), and saves a Formidable entry.

WPGraphQL for ACF exposes the group as `pageBuilder { sections { ... } }`, with one type per layout (`PageBuilderSectionsCardGridLayout`). Choices are button groups, which come back as plain strings. After changing fields, refresh the front-end's schema snapshot with `pnpm --filter web-wordpress codegen:schema`. After changing fields or the seed, re-record the adapter's fixtures from a fresh seed with `pnpm --filter @launch/adapter-wordpress record-fixtures` (its header says which credentials it needs), so the parity test in `packages/sections-preview` compares real WordPress output with Payload's.

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
- A post that a menu item links to also sends `list:menuitem`, because the menu item takes its label and URL from the post, while the menu read carries only the menu item's key.
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

- The theme, mu-plugins and plugins folders, and `wordpress-shared/patronage-fields`, are bind-mounted. If git replaces one of those directories (switching branches), the container keeps the old, now empty, mount: run `docker compose up -d --force-recreate wordpress`.
- WP-CLI runs as uid 33 (the Apache image's `www-data`), not the CLI image's default uid 82, so files it writes stay writable by WordPress.
- Composer downloads Formidable from wordpress.org and everything else from GitHub. The ACF and `composer/installers` zips come from GitHub's API, which allows 60 unauthenticated requests an hour; if you hit that, pass a token with `COMPOSER_DOCKER_ARGS='-e COMPOSER_AUTH={"github-oauth":{"github.com":"<token>"}}'`. The same variable can mount a proxy's CA bundle.
