# cms-wordpress-headless

WordPress as an editing tool and a GraphQL API for [`apps/web-wordpress`](../web-wordpress). It runs locally in Docker; nothing here renders the public site.

## What is in git

- `composer.json` and `composer.lock`: WPGraphQL, WPGraphQL for ACF and ACF (free). Composer installs them into `wp-content/plugins/`, which is gitignored.
- `wp-content/themes/patronage-headless/`: registers the primary menu and the Hero field group (in PHP, so fields live in git), points the editor's Preview button at the front-end with a signed link, and redirects visitors of WordPress's own front-end to the headless site.
- `wp-content/mu-plugins/patronage-headless-revalidate.php`: tells the front-end which paths and tags to revalidate when content is published, edited, moved, unpublished or trashed.
- `bin/setup.sh` and `bin/seed.sh`: install, configure and seed invented demo content.

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
- Stop, or wipe the database: `pnpm --filter cms-wordpress-headless stop` / `reset`

## How the pieces connect

| Concern | WordPress side | Front-end side |
| --- | --- | --- |
| Content | WPGraphQL at `/graphql` | `lib/wordpress/client.ts`, typed by codegen |
| Revalidation | mu-plugin sends `PUT /api/revalidate/` with `{paths, tags}` and `X-Headless-Secret-Key` | `app/api/revalidate/route.ts` calls `revalidatePath` and `revalidateTag` |
| Preview | theme rewrites the Preview link to `/api/preview/?token=…`, an HMAC of the post ID and an expiry | `app/api/preview/route.ts` checks it, enables draft mode, renders `/preview/<id>/` with the application password |

Check the revalidation round trip against a running front-end (it publishes, edits and trashes a test post):

```sh
pnpm --filter cms-wordpress-headless wp -- patronage-headless-revalidate verify
```

When WordPress runs in Docker it reaches the front-end at `HEADLESS_FRONTEND_INTERNAL_URL` (default `http://host.docker.internal:3000`), so run the front-end on port 3000 with `HOST=0.0.0.0` for production builds (`vinext start`).

## Gotchas

- The theme, mu-plugins and plugins folders are bind-mounted. If git replaces one of those directories (switching branches), the container keeps the old, now empty, mount: run `docker compose up -d --force-recreate wordpress`.
- WP-CLI runs as uid 33 (the Apache image's `www-data`), not the CLI image's default uid 82, so files it writes stay writable by WordPress.
- Composer downloads everything from GitHub. The ACF and `composer/installers` zips come from GitHub's API, which allows 60 unauthenticated requests an hour; if you hit that, pass a token with `COMPOSER_DOCKER_ARGS='-e COMPOSER_AUTH={"github-oauth":{"github.com":"<token>"}}'`. The same variable can mount a proxy's CA bundle.
