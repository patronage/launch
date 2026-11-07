# Deploying to Cloudways

This install deploys with [wp-deploy](../../../wordpress-shared/wp-deploy/README.md). `deploy.sh`, `pull.sh` and `cloudways-hook-post-receive.sh` here are symlinks to the canonical copies; the files in this folder are the site's own.

| File | Purpose |
| --- | --- |
| `deploy.env` | Committed settings: Cloudways, branch `main`, `bin/build.sh` as the build step, and `bin/after-import.sh` to run after a database import |
| `.deploy_include.txt` | Adds the build's gitignored output: `wp-content/plugins/*` (Composer, `--no-dev`) `wp-content/mu-plugins/patronage-access.php` (copied from [`wordpress-shared/patronage-access`](../../../wordpress-shared/patronage-access)) `wp-content/mu-plugins/patronage-logging.php` (copied from [`wordpress-shared/patronage-logging`](../../../wordpress-shared/patronage-logging)), `wp-content/mu-plugins/patronage-headless-revalidate/` (copied from [`wordpress-shared/patronage-headless-revalidate`](../../../wordpress-shared/patronage-headless-revalidate)) and `wp-content/mu-plugins/patronage-fields/` (copied from [`wordpress-shared/patronage-fields`](../../../wordpress-shared/patronage-fields)) |
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

## Pull the database and uploads

From `apps/cms-wordpress-headless`, with the local Docker site running (`pnpm run setup` or `pnpm start`):

```sh
pnpm run pull export production   # dump the server's database to _data/ (gitignored)
pnpm run pull import              # load the newest dump into local Docker, after asking
pnpm run pull media production    # copy the uploads into wp-content/uploads/ (gitignored)
```

They use the same `.env` settings as deploys, and read nothing but this app's own webroot (see [Pulls](../../../wordpress-shared/wp-deploy/README.md#pulls)). After the import, `bin/after-import.sh` replaces the server's `siteurl` and `home` with `http://localhost:8080` (or `WP_PORT`), and gives the `previewer` editor a new application password in `apps/web-wordpress/.env.local`. The import replaces the local users too, so sign in with your account on the server; `admin` / `admin` is gone until `pnpm run reset` and `pnpm run setup`.

Local uploads are the `wp-content/uploads/` folder, mounted into the containers, so `media` can fill it. A local install set up before the folder was mounted kept its uploads in the Docker volume: run `pnpm run reset` and `pnpm run setup` once to seed the demo images into the folder.

## First deploy over a hand-installed site

The first deploy syncs every plugin, the theme and the mu-plugins in the payload to the repo's versions, and the hook deletes nothing it didn't deploy. Check the dry run and the audit first, then deploy staging before production. Plugins installed on the server by hand stay until someone removes them (the audit lists them).

Plugins arrive deactivated. After the first deploy that adds one, activate it on the server, e.g. `wp plugin activate formidable` for the form section's Formidable Forms.

After a deploy that changes `graphql-documents.json`, the theme registers it on the next request, or run `wp patronage-headless documents` on the server.
