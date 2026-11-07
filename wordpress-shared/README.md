# wordpress-shared

Patronage's own WordPress code, used by the WordPress apps in this repo and, through Composer, by other sites.

| Folder | What it is | Composer package |
| --- | --- | --- |
| [`patronage-access`](patronage-access) | Cloudflare Access lock, browser login and gateway identity | `patronage/launch-access` |
| [`patronage-logging`](patronage-logging) | Security events and log files to the site's log bucket | `patronage/launch-logging` |
| [`patronage-headless-revalidate`](patronage-headless-revalidate) | Revalidates the headless front-end when content changes | `patronage/launch-headless-revalidate` |
| [`patronage-fleet`](patronage-fleet) | Version reports to Patronage Fleet, for Patronage-run sites | `patronage/launch-fleet` |
| [`patronage-fields`](patronage-fields) | Field groups, post types and seed for Launch's own two installs | (none) |
| [`wp-deploy`](wp-deploy) | The deploy kit each site copies or symlinks into `_build/` | (none yet) |
| [`plugin-release`](plugin-release) | `pnpm wp:release`, which publishes the Composer packages |  |

## Installing with Composer

Add `{"type": "composer", "url": "https://launch.patronage.com/composer"}` to a site's `repositories`, `composer require patronage/launch-access` (or another package), and commit a one-line loader beside the folder Composer installs, because WordPress loads only top-level mu-plugin files:

```php
<?php
// wp-content/mu-plugins/patronage-access.php
require_once __DIR__ . '/patronage-access/patronage-access.php';
```

The full steps are on the docs site: [WordPress plugins](https://launch.patronage.com/references/wordpress-plugins).

## Changing a package

A package's version is the `Version:` header of its main file. Bump it, run `pnpm wp:release <folder>`, and commit `apps/docs-site/public/composer/packages.json` and `apps/docs-site/composer-redirects.txt` with the change; `pnpm verify` fails until you do. After merge, `pnpm wp:release --publish` creates the GitHub releases that hold the zips. Each package's `.gitattributes` marks what stays out of its zip. See [ADR 0017](../docs/adr/0017-wordpress-plugins-through-composer.md).
