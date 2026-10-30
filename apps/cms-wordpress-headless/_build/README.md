# Deploying to Cloudways

This install deploys with [wp-deploy](../../../wordpress-shared/wp-deploy/README.md). `deploy.sh` and `cloudways-hook-post-receive.sh` here are symlinks to the canonical copies; the files in this folder are the site's own.

| File | Purpose |
| --- | --- |
| `deploy.env` | Committed settings: Cloudways, branch `main`, and `bin/build.sh` as the build step |
| `.deploy_include.txt` | Adds the build's gitignored output: `wp-content/plugins/*` (Composer, `--no-dev`) `wp-content/mu-plugins/patronage-access.php` (copied from [`wordpress-shared/patronage-access`](../../../wordpress-shared/patronage-access)) and `wp-content/mu-plugins/patronage-fields/` (copied from [`wordpress-shared/patronage-fields`](../../../wordpress-shared/patronage-fields)) |
| `.deploy_exclude.txt` | Keeps the local tooling (`bin/`, Docker and Composer files, this folder) out of the webroot |
| `wp-config-environment.php` | Sample block for each environment's `wp-config.php`: `HEADLESS_*`, revalidation and Access constants |

The repo is public, so the Cloudways server IPs, application paths and SSH users go in `.env` next to this folder (gitignored), not in `deploy.env`. `.env.example` lists the names.

## Deploy

From `apps/cms-wordpress-headless`, with a clean working tree:

```sh
pnpm run deploy staging --dry-run   # build and show the payload; needs no SSH
pnpm run deploy audit staging       # read-only report on the server's files
pnpm run deploy install-hook staging  # once per environment, and when deploy.sh says the hook differs
pnpm run deploy staging
pnpm run deploy production
```

`bin/build.sh` runs Composer on the host if it has one, else in the `composer:2` image. It stops if `wp-content/plugins` holds anything `composer.lock` doesn't install, since the include list ships that whole folder. The dry run is most trustworthy from a fresh clone.

The Cloudways hook receives the whole packaged commit (the monorepo, minus the excluded paths) and installs only this folder into the webroot. The repo is public, so nothing in it is secret; `wp-config.php` and `.env*` are refused by the payload check.

## First deploy over a hand-installed site

The first deploy syncs every plugin, the theme and the mu-plugins in the payload to the repo's versions, and the hook deletes nothing it didn't deploy. Check the dry run and the audit first, then deploy staging before production. Plugins installed on the server by hand stay until someone removes them (the audit lists them).

Plugins arrive deactivated. After the first deploy that adds one, activate it on the server, e.g. `wp plugin activate formidable` for the form section's Formidable Forms.

After a deploy that changes `graphql-documents.json`, the theme registers it on the next request, or run `wp patronage-headless documents` on the server.
