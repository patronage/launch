# Patronage Fleet

A WordPress mu-plugin that connects a site to Patronage Fleet, the internal tool Patronage uses to monitor the sites it maintains. It is mainly an internal monitoring tool: outside Patronage it does nothing useful, and it stays off unless configured.

It does two things:

- **Version reports.** Once a day, and a few minutes after any core, plugin or theme update, it posts the site's WordPress, PHP, plugin and theme versions to Fleet, which checks them for known vulnerabilities.
- **Uptime health route.** `GET /wp-json/patronage-fleet/v1/health` answers Fleet's uptime monitor.

This folder is the canonical copy. Each site keeps `patronage-fleet.php` in `wp-content/mu-plugins/`, unchanged. The header's `Version` names the release. Versions up to 1.1.0 also lived in Patronage's earlier `launch-wordpress` repo.

## Health route

`/wp-json/patronage-fleet/v1/health` needs no setup and runs on every environment. Once WordPress has loaded and the database answers `SELECT 1`, it returns HTTP 200 with `{"status":"ok"}`. If the database doesn't answer, it returns HTTP 503. It sends `Cache-Control: no-store` so a page cache can't hide an outage. It takes no input and reports no versions or settings.

It exists so that uptime checks keep working when Cloudflare Access protects `wp-login.php` and `wp-admin`. A monitor that looks for the login form sees the Access sign-in page instead and reports a false outage. Point the monitor at the health route and check for `"status":"ok"`.

If an Access application covers `/wp-json/*`, add a Bypass policy for this path. With [`patronage-access`](../patronage-access/README.md)'s origin guard on (`PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT`), every request needs an Access JWT, and a bypassed request has none. On such an install the monitor needs a service token instead. Some security plugins block anonymous REST requests; allow this route if so.

## Version reports

Reports go out only from production, and only once production's `wp-config.php` defines all four constants:

| Constant | Value |
| --- | --- |
| `PATRONAGE_FLEET_SITE` | The project's slug in Fleet |
| `PATRONAGE_FLEET_KEY` | The site's Ed25519 seed, from `fleet inventory keygen <slug>` |
| `PATRONAGE_FLEET_ACCESS_ID` | The shared site-report Cloudflare Access service token |
| `PATRONAGE_FLEET_ACCESS_SECRET` | Its secret |

`PATRONAGE_FLEET_URL` overrides the report endpoint.

**Security.** There are two layers. The Access service token, shared by all sites, gets the request to Fleet's report path and nowhere else. Each site also signs `<site>\n<timestamp>\n<body>` with its own Ed25519 key. Fleet keeps only the public half, so the key in `wp-config.php` can sign reports for this site and nothing else. Fleet rejects a report that is unsigned, older than five minutes, a replay, or from a home URL that isn't one of the project's domains.

**Low-traffic sites.** WordPress cron runs only when someone visits. If a site stops reporting, turn on the host's server cron for WordPress.

## WP-CLI

- `wp patronage-fleet report` sends a report now and prints Fleet's reply; `HTTP 202` means it was accepted.
- `wp patronage-fleet status` prints the configuration, the next scheduled report and the last result.
- `wp patronage-fleet inventory` prints the report without sending it.

## Tests

`pnpm --filter @patronage/wordpress-fleet test` lints the plugin and runs `tests/health.test.php` against stubbed WordPress functions.
