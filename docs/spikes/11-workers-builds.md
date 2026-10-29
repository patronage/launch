# Spike 6: Workers Builds and preview URLs

Issue: [#11](https://github.com/patronage/launch/issues/11). Builds on the `cf` deploy pattern from [Spike 1](02-vinext-on-workers.md).

## Status

The recipe and scripts are written and their API requests validate with `--dry-run`, but nothing has run against a Cloudflare account yet: this work was done without account credentials. The production deploy and the first preview URL are still to do, in the order under "First run".

## How it works

There are no GitHub Actions in this repo. Each deployable app is its own Worker with its own Workers Builds configuration:

| Setting | Value |
| --- | --- |
| Root directory | the app folder, e.g. `apps/spike-vinext` |
| Watch paths | `<app>/*`, `packages/*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, so a change to another app does not rebuild this one |
| Build command | `pnpm -w run verify`: frozen install, lint, typecheck and tests for the workspace. A failure stops the deploy |
| Production deploy command | `pnpm run deploy`, on `main` |
| Preview deploy command | `pnpm run deploy --preview`, on every other branch |
| Build variables | `NODE_VERSION` from `.nvmrc`, `PNPM_VERSION` from the root `packageManager`, `SKIP_DEPENDENCY_INSTALL=1` |

`SKIP_DEPENDENCY_INSTALL` is there because the app folder has no lockfile of its own. Without it, the build image would pick a package manager by looking for a lockfile in the root directory and find none. `pnpm verify` does the install instead, from the workspace root.

`scripts/workers-builds.mjs` creates this configuration through the Workers Builds API (`cf builds workers create`). It reads the Worker name from `cloudflare.config.ts` and the Node and pnpm versions from the repo, so the only inputs are ids.

Preview deploys use Worker Previews (`cf previews deploy`). Each branch gets its own Preview under the same Worker, at `<branch>-<worker>.<subdomain>.workers.dev`, and that URL always serves the branch's latest push. `cloudflare.config.ts` can tell a Preview build from a production build through `isPreview` on the config context, if a binding ever needs to differ.

## First run, per app

1. One time for the repo: install the Cloudflare GitHub app on `patronage/launch` from the dashboard (Workers & Pages, Create, connect GitHub). This is the only dashboard step.
2. Deploy once from a machine, so the Worker and its KV namespace exist: `pnpm run deploy`.
3. Set runtime secrets: `REVALIDATE_SECRET=… PREVIEW_SECRET=… pnpm run secrets`.
4. Find the build token with `cf builds tokens list`, and the GitHub owner and repo ids (`gh api repos/patronage/launch --jq '.owner.id, .id'`).
5. `BUILD_TOKEN_UUID=… GITHUB_OWNER_ID=… GITHUB_REPO_ID=… pnpm run builds:configure`.
6. Push a branch and check that its Preview URL comes up, then merge and check production.
7. Put Previews behind Cloudflare Access. Preview URLs are public by default; Access can cover one Worker's Previews or a hostname pattern. Scripting that belongs with the Access spike; until then, add the Access application by hand and note it in the issue.

## Custom domains

Set `WORKER_DOMAIN` as a build variable (for example `launch-wordpress.<zone>`), and the next production deploy attaches it as the Worker's custom domain. `WORKER_DOMAIN_PREVIEWS=true` also serves each Preview at `<preview>.<domain>`. Those hostnames sit two levels below the zone, so check the certificate first: a Free plan's Universal SSL covers only one level. Without it, Previews still get `<preview>-<worker>.<subdomain>.workers.dev`.

## Learned on the first run

- The Builds API takes each build variable as `{ "value": "…", "is_secret": false }`, not a bare string. A bare string gets `400 [12002] Invalid request body`.
- Each Preview keeps its own copy of the build settings, taken when the Preview is created. Changing `previews_base_config` only affects new Previews; send the update again with `--patch-existing-previews true` to change the ones that already exist.
- Watch paths decide whether a push builds at all. A change to only the root `.nvmrc` or `package.json` does not start one.
- The first Preview build passed (`pnpm -w run verify` plus `cf previews deploy`), so Workers Builds accepts `cf previews deploy` as the preview command.
- That Preview came back with no URL, because the Worker, created in the dashboard, had workers.dev turned off. `cloudflare.config.ts` now sets `workersDev` and `previewUrls`, and the next production deploy applies them.

## Things to confirm on the first run

These come from reading the docs and the `cf` CLI's API schema, not from a run:

- Whether Workers Builds puts `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the build environment. The docs say a build token is generated and used by the deploy command, but only list `CI`, `WORKERS_CI`, `WORKERS_CI_BRANCH`, `WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BUILD_UUID`. If the account id is missing, set it as a build variable.
- Whether `cf deploy` without `--secrets-file` keeps the secrets already on the Worker, as Wrangler does. The deploy script relies on that in CI, where secret values are not in the build environment.
- How Previews get secrets. The docs say a new Preview copies the Worker's base Preview secrets when it is created; the `cf` CLI has no command for those yet (Wrangler's is `wrangler preview base-config secret put`). The API behind it needs finding. Until then, a Preview without secrets still renders, but revalidation and draft mode return 401.
- Whether Previews share the production KV namespace. If they do, a Preview could serve or clear production cache entries; giving the Preview build its own namespace through `isPreview` would fix that.
