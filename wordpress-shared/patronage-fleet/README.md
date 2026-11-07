# Patronage Fleet

A WordPress mu-plugin for sites Patronage runs. Once a day, and again a few minutes after any core, plugin or theme update, it sends the site's WordPress, PHP, plugin and theme versions to Patronage Fleet, which checks them for known vulnerabilities. It only sends: it adds no page, route or endpoint to the site. It is of no use outside Patronage's fleet, and is published here so Patronage sites can install it with Composer.

**It does nothing outside production, or until production's `wp-config.php` defines all four constants:**

| Constant | Value |
| --- | --- |
| `PATRONAGE_FLEET_SITE` | The site's slug in Fleet |
| `PATRONAGE_FLEET_KEY` | The site's Ed25519 seed, base64, from Fleet's `inventory keygen <slug>` |
| `PATRONAGE_FLEET_ACCESS_ID`, `PATRONAGE_FLEET_ACCESS_SECRET` | The shared site-report Cloudflare Access service token |

Put them in the `production` entry of the site's environment block, so staging copies never report. `PATRONAGE_FLEET_URL` overrides the report URL. Reports need PHP's sodium extension.

## Security

Two layers. The Access service token, shared by all sites, gets a request to Fleet's report path and nowhere else; anything without it stops at Cloudflare. Each site also has its own Ed25519 key, and Fleet stores only the public half, so the key in `wp-config.php` can sign reports for this one site and nothing else. Each report signs `<site>\n<timestamp>\n<body>`, and Fleet rejects one that is unsigned, older than five minutes, a replay, or from a home URL that isn't one of the site's domains.

## Commands

- `wp patronage-fleet report` sends the report now and prints Fleet's reply (`HTTP 202` when it's accepted).
- `wp patronage-fleet status` shows the configuration, the next scheduled report and the last result.
- `wp patronage-fleet inventory` prints the report without sending it.

WordPress cron runs only when someone visits, so on a low-traffic site turn on the host's server cron (WP Engine's Alternate Cron, or a Cloudways or Kinsta cron job running `wp cron event run --due-now`). Fleet lists a site that hasn't reported for 48 hours as stale.

## Install

See [Installing with Composer](../README.md#installing-with-composer).
