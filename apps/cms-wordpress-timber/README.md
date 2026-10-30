# cms-wordpress-timber

Traditional WordPress: the same editor and content as [`apps/cms-wordpress-headless`](../cms-wordpress-headless), but WordPress renders the public site itself, with a [Timber](https://timber.github.io/docs/v2/) theme. It runs locally in Docker. See [ADR 0006](../../docs/adr/0006-separate-wordpress-installs.md) for why it is a separate install.

## What is in git

- `composer.json` and `composer.lock`: Timber (and Twig), [Secure Custom Fields](https://github.com/WordPress/secure-custom-fields), [Extended ACF](https://github.com/vinkla/extended-acf) and [Extended CPTs](https://github.com/johnbillion/extended-cpts). Composer installs them into `wp-content/plugins/`, which is gitignored.
- `wp-content/mu-plugins/patronage-fields.php`: loads the field groups and post types both installs share, from [`wordpress-shared/patronage-fields`](../../wordpress-shared/patronage-fields).
- `wp-content/themes/patronage-timber/`: the theme (see [Theme](#theme)).
- `_build/`: deploys to Cloudways with [wp-deploy](../../wordpress-shared/wp-deploy/README.md), as the headless install does, plus a sample `wp-config.php` block.
- `bin/setup.sh` and `bin/seed.sh`: install, configure and seed the invented demo content the headless install seeds too.

## Run it

Needs Docker and pnpm (for the theme's CSS). Composer runs in its official image (`pnpm --filter cms-wordpress-timber composer -- update` to change versions).

```sh
pnpm --filter cms-wordpress-timber setup     # composer install, build CSS, start Docker, install and seed
pnpm --filter cms-wordpress-timber dev:css   # rebuild the CSS while editing views
```

`setup` is safe to rerun.

- Site: http://localhost:8090/ (the headless install uses 8080, so both can run)
- Admin: http://localhost:8090/wp-admin/ (`admin` / `admin`, local only)
- WP-CLI: `pnpm --filter cms-wordpress-timber wp -- <command>`
- Reseed (adds missing pages, leaves existing ones alone): `pnpm --filter cms-wordpress-timber seed`
- Stop, or wipe the database: `pnpm --filter cms-wordpress-timber stop` / `reset`

## Theme

The theme draws the same pages as the vinext and Payload front-ends, from the same content model, without their React components ([ADR 0006](../../docs/adr/0006-separate-wordpress-installs.md) shares design tokens only).

| Concern | Where |
| --- | --- |
| Field data to the content model | `inc/content.php` maps ACF's values to the shapes in [`packages/content-model`](../../packages/content-model) (`Hero`, `Section`, `Link`, `Image`), so views read the same model as the React blocks, collapse same-skin padding the same way, and pick the same `<h1>`. |
| Views | `views/sections/` has one Twig file per block, `views/heroes/` the hero variants, `views/page.twig` a page, `views/single.twig` a post, `views/index.twig` the `/news/` list. Each says which `packages/ui` component it mirrors. |
| Look | `views/components/ui.twig` holds the class names of `@launch/ui`'s `Section`, `Container`, `Typography` and button variants. Change them here when they change there. |
| CSS | `assets/main.css` imports Tailwind and `@launch/ui/theme.css` (the tokens mapped into Tailwind's theme) and scans only this theme. `build:css` writes `dist/main.css`, which is gitignored and built again by deploys. |
| Escaping | Twig autoescapes everything. Rich text, which WordPress has already filtered, prints through the `rich` filter. |

## Gotchas

- The theme, mu-plugins and plugins folders, and `wordpress-shared/patronage-fields`, are bind-mounted. If git replaces one of those directories (switching branches), run `docker compose up -d --force-recreate wordpress`.
- WP-CLI runs as uid 33 (the Apache image's `www-data`), so files it writes stay writable by WordPress.
- Composer downloads everything from GitHub, which allows 60 unauthenticated API requests an hour. Pass a token with `COMPOSER_DOCKER_ARGS='-e COMPOSER_AUTH={"github-oauth":{"github.com":"<token>"}}'`.
- Cloudflare Access belongs on `/wp-admin` and `/wp-login.php` here, not the whole hostname, since WordPress serves the public site. The `patronage-access` mu-plugin's origin guard would lock out visitors, so this install does not ship it.
