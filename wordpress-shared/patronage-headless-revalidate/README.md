# Patronage Headless Revalidate

A WordPress mu-plugin that tells a headless front-end which paths and cache tags to revalidate when content is published, edited, renamed, unpublished or trashed. [`apps/cms-wordpress-headless`](../../apps/cms-wordpress-headless) runs it for [`apps/web-wordpress`](../../apps/web-wordpress), whose `app/api/revalidate/route.ts` receives the request.

**It does nothing until configured.** Each environment's `wp-config.php` defines:

```php
define( 'PATRONAGE_REVALIDATE_URL', 'https://www.example.org' ); // the front-end origin
define( 'PATRONAGE_REVALIDATE_SECRET', 'same value as the front-end' );
// Optional: a Cloudflare Access service token, for a front-end behind Access.
define( 'PATRONAGE_REVALIDATE_ACCESS_ID', '…' );
define( 'PATRONAGE_REVALIDATE_ACCESS_SECRET', '…' );
```

## What it sends

Changes are queued during the request and sent once, at shutdown, as `PUT {paths, tags}` to `/api/revalidate/` with an `X-Headless-Secret-Key` header. A post's own path, its old path after a rename or unpublish, and its descendants' paths are queued, with the tag `wordpress`.

A theme adds its own with `patronage_headless_revalidate_queue_paths()` and `patronage_headless_revalidate_queue_tags()`, and sends early with `patronage_headless_revalidate_flush()`. Filters: `patronage_headless_revalidate_endpoint` (the route path) and `patronage_headless_revalidate_post_tags` (a post's tags). The headless theme's `inc/cache-tags.php` uses them to send every key WPGraphQL Smart Cache purges.

`wp patronage-headless-revalidate verify` publishes, edits and trashes a test post and checks the front-end after each step (production needs `--yes`).

## Install

See [Installing with Composer](../README.md#installing-with-composer). Inside this repo, the headless install commits a one-line `wp-content/mu-plugins/patronage-headless-revalidate.php` that loads this folder: Docker bind-mounts it, and `bin/build.sh` copies it in for deploys.

## Tests

`pnpm --filter @patronage/wordpress-headless-revalidate test` runs `tests/revalidate.test.php`, plain PHP that loads the plugin against an in-memory WordPress: path mapping, the queue, the request it sends and how it reads the answer, and which post changes send which paths. `verify` above is the end-to-end check against a real front-end.
