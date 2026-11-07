# Deploying to Cloudways

This install deploys with [wp-deploy](../../../wordpress-shared/wp-deploy/README.md), the same way as [the headless install](../../cms-wordpress-headless/_build/README.md). `deploy.sh` and `cloudways-hook-post-receive.sh` here are symlinks to the canonical copies; the files in this folder are the site's own.

| File | Purpose |
| --- | --- |
| `deploy.env` | Committed settings: Cloudways, branch `main`, and `bin/build.sh` as the build step |
| `.deploy_include.txt` | Adds the build's gitignored output: `wp-content/plugins/*` (Composer, `--no-dev`), the theme's `dist/` CSS, and `wp-content/mu-plugins/patronage-fields/` (copied from [`wordpress-shared/patronage-fields`](../../../wordpress-shared/patronage-fields)) |
| `.deploy_exclude.txt` | Keeps the local tooling (`bin/`, Docker, Composer and pnpm files, the CSS source, this folder) out of the webroot |
| `wp-config-environment.php` | Sample block for each environment's `wp-config.php` |

The repo is public, so the Cloudways server IPs, application paths and SSH users go in `.env` next to this folder (gitignored), not in `deploy.env`. `.env.example` lists the names.

`bin/build.sh` needs pnpm on the machine that deploys, to build the CSS. Run the deploy commands from `apps/cms-wordpress-timber` as the headless README shows (`pnpm run deploy staging --dry-run` first).
