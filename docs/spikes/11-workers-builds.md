# Spike 6: Workers Builds and preview URLs

Issue: [#11](https://github.com/patronage/launch/issues/11). Builds on the `cf` deploy pattern from [Spike 1](02-vinext-on-workers.md).

## Status

Live. Workers Builds builds and deploys `apps/web-wordpress`, `apps/payload` and `apps/docs-site` from `main`, and branch Previews build for `apps/web-wordpress` (`apps/payload` has branch builds off by default). What the runs settled and what is still open is at the end.

## How it works

There are no GitHub Actions in this repo. Each deployable app is its own Worker with its own Workers Builds configuration:

| Setting | Value |
| --- | --- |
| Root directory | the app folder, e.g. `apps/web-wordpress` |
| Watch paths | `<app>/*`, `packages/*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, so a change to another app does not rebuild this one |
| Build command | Frozen install and lint for the workspace, then typecheck and tests for the app and the packages it depends on (`pnpm --filter "<app>..."`). A failure stops the deploy. The full `pnpm verify` is not used because it also runs the WordPress installs' PHP checks, and the build image has no PHP |
| Production deploy command | `pnpm run deploy`, on `main` |
| Preview deploy command | `pnpm run deploy --preview`, on every other branch |
| Build variables | `NODE_VERSION` from `.nvmrc`, `PNPM_VERSION` from the root `packageManager`, `SKIP_DEPENDENCY_INSTALL=1` |

`SKIP_DEPENDENCY_INSTALL` is there because the app folder has no lockfile of its own. Without it, the build image would pick a package manager by looking for a lockfile in the root directory and find none. The build command's `pnpm -w run deps:verify` does the install instead, from the workspace root.

`scripts/workers-builds.mjs` creates this configuration through the Workers Builds API (`cf builds workers create`). It reads the Worker name from `cloudflare.config.ts` and the Node and pnpm versions from the repo, so the only inputs are ids.

Preview deploys use Worker Previews (`cf previews deploy`). Each branch gets its own Preview under the same Worker, at `<branch>-<worker>.<subdomain>.workers.dev`, and that URL always serves the branch's latest push. `cloudflare.config.ts` can tell a Preview build from a production build through `isPreview` on the config context, if a binding ever needs to differ.

## First run, per app

1. One time for the repo: install the Cloudflare GitHub app on `patronage/launch` from the dashboard (Workers & Pages, Create, connect GitHub). This is the only dashboard step.
2. Deploy once from a machine, so the Worker and its KV namespace exist: `pnpm run deploy`.
3. Set the runtime secrets that `cloudflare.config.ts` declares with `pnpm run secrets`, values from the environment. Never add them as build variables.
4. Find the build token with `cf builds tokens list`, and the GitHub owner and repo ids (`gh api repos/patronage/launch --jq '.owner.id, .id'`).
5. `BUILD_TOKEN_UUID=… GITHUB_OWNER_ID=… GITHUB_REPO_ID=… pnpm run builds:configure`. It runs every call through `cf`, so `cf auth login` is enough; no API token.
6. Push a branch and check that its Preview URL comes up, then merge and check production.
7. Put Previews behind Cloudflare Access. Preview URLs are public by default; Access can cover one Worker's Previews or a hostname pattern. Scripting that belongs with the Access spike; until then, add the Access application by hand and note it in the issue.

## Custom domains

Set `WORKER_DOMAIN` as a build variable (for example `launch-wordpress.<zone>`), and the next production deploy attaches it as the Worker's custom domain. `WORKER_DOMAIN_PREVIEWS=true` also serves each Preview at `<preview>.<domain>`. Those hostnames sit two levels below the zone, so check the certificate first: a Free plan's Universal SSL covers only one level. Without it, Previews still get `<preview>-<worker>.<subdomain>.workers.dev`.

## Learned on the first run

- The Builds API takes each build variable as `{ "value": "…", "is_secret": false }`, not a bare string. A bare string gets `400 [12002] Invalid request body`.
- Each Preview keeps its own copy of the build settings, taken when the Preview is created. Changing `previews_base_config` only affects new Previews; send the update again with `--patch-existing-previews true` to change the ones that already exist.
- Watch paths decide whether a push builds at all. A change to only the root `.nvmrc` or `package.json` does not start one.
- The first Preview build passed (`pnpm -w run verify` plus `cf previews deploy`), so Workers Builds accepts `cf previews deploy` as the preview command.
- The build image has no PHP, so the full `pnpm verify` fails on the WordPress installs' checks. Build commands run the frozen install and lint for the workspace, then typecheck and test only the app and its dependencies.
- `cf deploy` refuses to run while a declared secret is unset, and its automatic provisioning fails with `[10014]` when a KV namespace of the same title exists but no deployed version binds it. That happens after a failed first deploy; bind the existing namespace by id in `cloudflare.config.ts` instead.
- That Preview came back with no URL, because the Worker, created in the dashboard, had workers.dev turned off. `cloudflare.config.ts` now sets `workersDev` and `previewUrls`, and the next production deploy applies them.

## Settled by the production runs

All three Workers (`launch-vinext-wordpress`, `launch-payload`, `launch-docs`) deploy from `main` through Workers Builds as of 2026-10-30.

- Workers Builds gives the deploy command working Cloudflare credentials: `cf deploy` runs with no account id or token set as build variables.
- `cf deploy` without `--secrets-file` keeps the secrets already on the Worker. Production builds deploy with no secret values in the build environment.
- Previews use their own KV namespace: `apps/web-wordpress` binds the production namespace by id only when the build is not a Preview.

- Build variables are copied onto the Builds trigger when `builds:configure` creates it. Payload's trigger predated its `ACCESS_*` settings, so every Builds deploy blanked them and turned its Access sign-in off until they were added with `cf builds triggers environment-variables upsert`. The steps are in the docs site's Workers Builds page.
- The Builds commands take the script tag, not the Worker name, and a Builds deploy shows up as `cf_cli` in the deployment list, like a laptop deploy.

Still open:

- How Previews get secrets. A new Preview copies the Worker's Previews base secrets when it is created; `apps/payload` sets them with `pnpm run secrets --preview-base`. Until a Worker has them, `apps/web-wordpress` Previews render, but revalidation and draft mode fail. A Payload Preview cannot start without `PAYLOAD_SECRET` at all, which is why its `builds:configure` refuses to turn branch builds on until the base secrets exist. The `apps/web-wordpress` Previews built so far are not full CMS preview environments.
- Putting Previews behind Access (step 7 above).
