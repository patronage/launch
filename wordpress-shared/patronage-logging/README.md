# Patronage Logging

A WordPress mu-plugin that records security-relevant events as wide events and ships them, with the host's own log files, to a Basin Pipelines stream that writes into the site's log bucket. It is for hosts with no Logpush, such as Cloudways. The decision is [ADR 0016](../../docs/adr/0016-logs-to-r2-through-logpush.md).

**It does nothing unless configured.** Without both `PATRONAGE_LOGGING_ENDPOINT` and `PATRONAGE_LOGGING_TOKEN`, it registers no hooks, writes no files and makes no requests, and `wp patronage-logging ship` exits quietly. Both WordPress installs ship it in that state.

## What it records

One event per request that did something worth keeping:

- logins, failed logins (with the username tried) and logouts;
- users created, deleted or given a new role;
- plugins activated, deactivated, deleted or updated, themes switched or updated;
- changes to `siteurl`, `home`, `admin_email`, `users_can_register` and `default_role` (filter `patronage_logging_watched_options` to add more);
- application passwords created, deleted or used;
- content status changes (published, trashed and so on);
- writes to wp-admin, admin-ajax, REST, WPGraphQL, XML-RPC or the login form, page views by a signed-in person in wp-admin, and any 5xx response.

Anonymous reads, such as the headless front end's WPGraphQL queries, are skipped: Cloudflare's own logs cover that traffic.

Each event has the method, the kind of request, the path without its query string, status, duration, user id, client IP (`CF-Connecting-IP` when present), `cf-ray`, user agent and the list of actions. It holds no request bodies, cookies, passwords, post content or email addresses.

With `PATRONAGE_LOGGING_FILES` set, new lines from those files go to the same stream, one record per line with `source: "wordpress-server"`.

## How it ships

A request never waits on the network. Events are appended to a spool file at shutdown, and `wp patronage-logging ship` sends the spool and any new log lines in batches. A failed send keeps everything for the next run. Log files are read from a saved offset, and a rotated file starts again from the top.

The spool lives in the host's private folder beside the web root when there is one (Cloudways: `private_html/patronage-logging`), otherwise in the system temp folder. Its files end in `.php` and start with an exit line, so a web server that can reach them runs them instead of serving them.

The token can only send. Whoever takes over the server can add noise but cannot read or delete what already left.

## Configuration

```php
// Required, both. packages/logging's provision script prints them.
define( 'PATRONAGE_LOGGING_ENDPOINT', 'https://<stream id>.ingest.cloudflare.com' );
define( 'PATRONAGE_LOGGING_TOKEN', 'send-only Pipelines token' );

// Optional: host log files to ship. Cloudways keeps an app's logs in ../logs.
define( 'PATRONAGE_LOGGING_FILES', array( dirname( ABSPATH ) . '/logs/*.log' ) );

// Optional.
define( 'PATRONAGE_LOGGING_SITE', 'cms.example.org' );      // defaults to the home URL's host
define( 'PATRONAGE_LOGGING_SPOOL_DIR', '/path/outside/webroot' );
define( 'PATRONAGE_LOGGING_WP_CRON', true );                 // ship every five minutes from WP-Cron
```

## Run the shipper

On a host with a server cron (Cloudways: Application, Cron Job Management), run every five minutes:

```bash
cd /path/to/public_html && wp patronage-logging ship --quiet
```

Without a server cron, set `PATRONAGE_LOGGING_WP_CRON` instead, which depends on site traffic.

`wp patronage-logging status` shows what is configured and which log files match, and `wp patronage-logging test` sends one test event.

## Tests

`pnpm --filter @patronage/wordpress-logging test` runs plain PHP tests, including one that loads the plugin with nothing configured and checks it registers no hooks.
