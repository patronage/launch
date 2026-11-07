# ADR 0017: Patronage WordPress plugins install through Launch's Composer repository

## Status

Accepted, 2026-11-07.

## Context

Patronage's own mu-plugins (Access, Logging, Headless Revalidate, Fleet) are copied by hand into every site that uses them, and the copies drift: one Fleet reporter sits in more than a dozen site repos. Composer is how those sites already install every other plugin. Composer installs a package from the root of whatever it downloads, so it can't install from a folder of this monorepo, and Launch is one repo (ADR 0001).

The options were a read-only mirror repo per plugin, published to Packagist; GitHub release zips listed by hand in each site's `package` repositories, as the apps do for WPGraphQL; or a Composer repository of our own.

## Decision

- Launch serves a Composer repository at `https://launch.patronage.com/composer`. The docs site publishes `apps/docs-site/public/composer/packages.json`, and each version's download URL there redirects (static rules in the docs site's `_redirects`) to a zip attached to that version's GitHub release on `patronage/launch`. There are no mirror repos, no Packagist listing and no zips in git.
- Packages are named `patronage/launch-<name>` so they don't read as generic (`patronage/launch-access`, not `patronage/access` or `wp-deploy`). `extra.installer-name` keeps the folder WordPress loads as `patronage-<name>`.
- A package's version is its main file's `Version:` header. The PR that changes a package bumps it and runs `pnpm wp:release <folder>`, which records the version and the zip's checksum in `packages.json`. After merge, `pnpm wp:release --publish` creates the GitHub releases. The zip is built byte for byte the same on any machine, so `pnpm verify` fails when a package's files or metadata no longer match their released version.
- Zips hold only what WordPress runs, plus the license: README, tests, `composer.json` and `package.json` are `export-ignore`.
- Packages that only Launch's own installs use, such as `patronage-fields`, stay out of the repository.

## Security

Making Launch, and these plugins, public was weighed against keeping them private to reduce what an attacker, increasingly an automated one, can read. AI makes reading public code for bugs cheap, so a published plugin should be assumed to be read closely.

We publish anyway. The plugins don't keep sites safe by being hidden: Cloudflare Access in front of each CMS and of Fleet is the control, and Patronage Access and the Fleet reporter hold no secrets, only the code that checks them. Hidden code delays an attacker little and gets no outside review. What publishing does add is a way to find every site running a version with a known bug, so the zips leave out the README, `composer.json` and other files that would show a version from the web, and a fix ships as a new version sites can take with `composer update`.

## Consequences

- Sites add one `repositories` entry and `composer require` the packages, then load each mu-plugin from a one-line file in `wp-content/mu-plugins/` (WordPress loads only top-level mu-plugin files), or use an mu-plugin autoloader such as Bedrock's.
- A plugin change can't merge without a version bump and a release; `pnpm verify` says so.
- Publishing needs the `gh` CLI signed in with permission to create releases on `patronage/launch`. Between merge and `--publish`, the new version's download 404s.
- Released versions are never rebuilt or replaced; the checksum in `packages.json` would stop every install of them.
- wp-deploy is a package too, `patronage/launch-wp-deploy` (type `library`, versioned by `deploy.sh`'s `Version:` header through `extra.launch-version-file`), added 2026-11-07. Sites require it as a dev dependency, because these installs keep Composer's vendor folder in the webroot and a production `composer install --no-dev` then leaves the shell scripts out. The site's `_build/deploy.sh` and `_build/pull.sh` are copies of the package's `shim.sh`, which run the installed script with `WP_DEPLOY_BUILD_DIR` pointing at `_build/`, where the site's settings stay.
