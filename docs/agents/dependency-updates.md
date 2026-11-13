# Weekly dependency updates

A procedure an unattended agent can follow once a week to move Launch's npm and Composer dependencies to their latest minor and patch releases, prove nothing broke, and open one PR. Run every command from the repo root unless a step says otherwise. A full run takes about 15 minutes, most of it `pnpm verify` (about 2.5 minutes, run at least twice) and the smoke tests.

## Rules

- **Minor and patch only.** No major versions. For 0.x packages a minor (0.21 to 0.33) is a major. List the majors `pnpm deps:major` shows in the PR body instead.
- **Release age.** Take only versions published at least `minimumReleaseAge` minutes ago (180 now, set in `pnpm-workspace.yaml`; it will move to 4320). taze and pnpm read it for npm. Composer has no such setting, so check publish times by hand for the inline packages below.
- **Exact pins.** Versions stay exact (`savePrefix: ""`). Shared dependencies stay `"catalog:"` in each `package.json`; their versions live in the `catalog` in `pnpm-workspace.yaml`.
- **vinext stays on 1.4.x.**
- **`@types/node` stays on the Node major in `.nvmrc`** (24). taze excludes it (`taze.config.js`), so check by hand: `npm view @types/node versions --json` and take the newest `24.x` past the age window, in the catalog.
- **pnpm stays where it is.** Don't take a `packageManager` bump (root and `.deepsec/package.json`). Workers Builds reads `PNPM_VERSION` from it only when `builds:configure` runs, which this procedure never does. Revert it after `deps:update` and keep `.deepsec/Dockerfile`'s `corepack prepare pnpm@…` matching.
- **No WordPress plugin release.** Never change a `Version:` header or any `wordpress-shared/*/composer.json`. `pnpm wp:release --check` (inside `pnpm test`) proves it. `wordpress-shared/*/package.json` isn't in the plugin zips, so it may change.
- **Changeset, never a release.** If `src/` or `package.json` changes in `@patronage/access` or an `@patronage/mcp-*` package, add a patch changeset. Never run `changeset version`, `changeset publish`, `pnpm release`, tag, or create a GitHub release.
- **Never deploy.** No `pnpm run deploy`, `pnpm run secrets`, `cf deploy`, `builds:configure`. No Wrangler config files, nothing under `.github/`.
- **Never commit** `vendor/`, `wp-content/plugins/`, `composer-libs/`, `.env*`, `.dev.vars`, evidence or `.state/`.

## Current holds

`deps:update` proposes these every week. Revert each one after `deps:update` unless its unblock condition is met; if you think it is, try it and keep it only if every check below passes. Update this table in the same PR when a hold is added or lifted.

| Package | Held at | Why | Unblock when |
| --- | --- | --- | --- |
| `payload`, `@payloadcms/*` (`apps/payload`) | 4.0.0-beta.6 | beta.8 adds `_stored` and `_transforms` columns to `media`; the committed D1 and Postgres migrations don't create them, so the seed fails. Verify and build still pass, only the seed catches it. | A separate PR adds the migrations (`apps/payload/src/migrations/d1` and `postgres`). |
| `pg`, `@types/pg` (`apps/payload`) | 8.20.0 | `@payloadcms/db-postgres` pins both exactly. A second `@types/pg` fails the Payload typecheck. | db-postgres moves its pins. Match them. |
| `@modelcontextprotocol/client`, `@modelcontextprotocol/server` (`packages/mcp-core`) | 2.0.0 | `agents` 0.21.0 pins them exactly (`pnpm peers check`). `agents` 0.33 is a 0.x major. | `agents` is upgraded in its own PR. |
| `packageManager` pnpm | 12.16.1 | See Rules. | A PR that also reruns `builds:configure` for each app. |
| `wordpress/secure-custom-fields` | 6.9.8 | 6.9.9's GitHub release had no `secure-custom-fields.zip` asset (2026-11-12). | The asset URL returns 200. |

## 1. Set up

```bash
export LC_ALL=en_US.UTF-8                      # local Postgres and some tools need it
nvm use                                        # Node 24 from .nvmrc
git fetch origin main                          # fetch main on its own: a missing branch name in the same fetch fails the whole fetch
git switch -c deps/$(date +%Y-%m-%d) origin/main
pnpm install --frozen-lockfile
```

Fetch `main` again right before you push and rebase if it moved; never `git reset --soft origin/main` after a fetch, or your commit will undo whatever landed.

## 2. npm (workspace)

```bash
pnpm deps:check                                # taze -r -l: what minor/patch updates exist inside the age window
pnpm deps:major > /tmp/deps-majors.txt         # majors, for the PR body only
pnpm deps:update                               # taze minor -r -l -w: writes package.json files and the catalog
```

Then apply the holds (edit the `package.json` back) and revert `packageManager` in the root `package.json`. Then:

```bash
pnpm install
pnpm peers check
```

Compare `pnpm peers check` with `main`. A new unmet peer with an exact range (like `agents` wanting `@modelcontextprotocol/server` `2.0.0`) means the bump splits a package in two: hold it. Two existing warnings are expected (`oxc-transform-react` under docs-site, `esbuild` under apps/payload). Check that no catalog entry became a version (`git diff | grep catalog` shows nothing) and that vinext is still `1.4.x`.

If `@playwright/test`/`playwright` moved, install its browser before the smoke tests: `pnpm --filter payload exec playwright install chromium`.

## 3. npm (`.deepsec` scanner workspace)

It has its own `package.json`, lockfile and `pnpm-workspace.yaml` (same age window) and no taze of its own. Running `pnpm exec` inside it tries an install that fails on ignored build scripts, so drive it from the root:

```bash
./node_modules/.bin/taze minor -l -w -C .deepsec
cd .deepsec && pnpm install --lockfile-only && pnpm install --frozen-lockfile --ignore-scripts && cd ..
```

Revert `packageManager` in `.deepsec/package.json` if taze changed it, then rerun `pnpm install --lockfile-only` there (the lockfile records the pnpm version too: `grep -c pnpm/exe .deepsec/pnpm-lock.yaml` should match `main`). If `deepsec` moved, update the version in `.deepsec/README.md` (first line) and `.deepsec/scripts/scan.mjs` (`deepsec: "…"` in the result JSON). With Docker running, prove it with `pnpm security:scan` (about 30 seconds; `result.json` in the printed run directory names the DeepSec version).

## 4. Changeset

If `git diff --name-only origin/main -- packages/access packages/mcp-core packages/mcp-payload packages/mcp-wordpress` lists a `package.json` or `src/` file, write `.changeset/dependency-updates-<date>.md`:

```md
---
"@patronage/mcp-core": patch
---

Updated dependencies to their latest minor and patch releases.
```

List each changed published package. `pnpm release:check` runs `changeset status --since=origin/main`, which only sees committed changesets, so commit before `pnpm verify` or it fails with "no changesets were found".

## 5. Composer (both WordPress installs)

Packagist dependencies:

```bash
(cd apps/cms-wordpress-headless && composer outdated --locked --all)
(cd apps/cms-wordpress-timber && composer outdated --locked --all)
```

For each direct dependency marked `!` (minor or patch), check its release date on `https://repo.packagist.org/p2/<vendor>/<name>.json` (`time` of the newest version), then raise the exact pin in `composer.json`. Ignore `~` (major).

The inline `"type": "package"` repositories are invisible to `composer outdated`. Check each by hand:

| Package | Where releases are | Asset URL |
| --- | --- | --- |
| `wp-graphql/wp-graphql`, `wp-graphql/wp-graphql-acf`, `wp-graphql/wp-graphql-smart-cache` (headless) | `gh release list -R wp-graphql/wp-graphql -L 40`; tags look like `wp-graphql-acf/v3.2.1` | `https://github.com/wp-graphql/wp-graphql/releases/download/<name>%2Fv<version>/<name>.zip` |
| `wordpress/secure-custom-fields` (both) | `gh release list -R WordPress/secure-custom-fields` | `https://github.com/WordPress/secure-custom-fields/releases/download/<version>/secure-custom-fields.zip` |
| `wordpress-plugin/formidable` (both) | `curl -s -g 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=formidable'` (`version`, `last_updated`) | `https://downloads.wordpress.org/plugin/formidable.<version>.zip` |

Without `gh`, `curl -s 'https://api.github.com/repos/wp-graphql/wp-graphql/releases?per_page=40'` gives the same tags and `published_at`. For each candidate:

1. It is minor or patch, not a prerelease, and published at least 3 hours ago (compare with `date -u`).
2. The asset exists: `curl -sIL -o /dev/null -w '%{http_code}' <asset url>` prints `200`. A release can be published before its zip is attached.
3. Change all three places in `composer.json` together: the `require` pin, the repository's `package.version`, and its `dist.url`.

Then refresh each lock, including transitive dependencies:

```bash
(cd apps/cms-wordpress-headless && composer update --no-interaction)
(cd apps/cms-wordpress-timber && composer update --no-interaction)
```

Commit `composer.json` and `composer.lock` only. The plugins it installs land in gitignored folders.

## 6. Verify

```bash
pnpm verify                                    # ~2.5 min: frozen install, lint, release:check, typecheck, tests (incl. wp:release --check and the PHP tests)
pnpm build                                     # ~10 s with a warm cache
```

`SOURCEMAP_BROKEN` and tsdown's `tsgo` deprecation warnings are expected.

## 7. Smoke tests

Follow `.agents/skills/launch-verify/SKILL.md`. Payload needs no Docker and must always run: it is the only check that applies the migrations and seeds a fresh database, which is what caught Payload beta.8.

```bash
cp apps/payload/.env.example apps/payload/.env  # set PAYLOAD_SECRET=$(openssl rand -hex 32), once per checkout
cp apps/payload/.env apps/payload/.dev.vars
rm -rf apps/payload/.cloudflare/state           # fresh local D1, so migrations and seed run from scratch
node .agents/skills/launch-verify/scripts/verify.ts launch payload
pnpm --filter payload seed
node .agents/skills/launch-verify/scripts/verify.ts drive payload pages
node .agents/skills/launch-verify/scripts/verify.ts drive payload apply-form
node .agents/skills/launch-verify/scripts/verify.ts drive payload seo
node .agents/skills/launch-verify/scripts/verify.ts cleanup payload
```

WordPress needs Docker. The Docker images (`mariadb:11`, `wordpress:php8.3-apache`, `wordpress:cli-php8.3`, and `composer:2` used by `bin/setup.sh`) are floating tags: don't change them, pull them first.

```bash
(cd apps/cms-wordpress-headless && HEADLESS_SECRET=pull-only docker compose --profile '*' pull)   # compose refuses to parse without .env on a fresh checkout
(cd apps/cms-wordpress-timber && docker compose --profile '*' pull)
docker pull composer:2
pnpm --filter cms-wordpress-headless run setup
node .agents/skills/launch-verify/scripts/verify.ts launch web-wordpress
node .agents/skills/launch-verify/scripts/verify.ts drive web-wordpress pages
```

Look at `01-home.png`. If images are broken, the shared WordPress volume holds media seeded from another checkout whose `wp-content/uploads` this checkout doesn't have: when nobody else is using local WordPress, `pnpm --filter cms-wordpress-headless reset`, then `run setup` again. Pulling a newer `wordpress` image doesn't upgrade core in an existing volume either; a reset does.

Then submit a WordPress form (`/get-involved/`) as `forms.md` describes, counting Formidable entries before and after with `pnpm --filter cms-wordpress-headless wp eval 'echo count(FrmEntry::getAll([]));'` (no `--` before `eval` under pnpm 12). Expect `POST /forms/submit/` 201, the confirmation in an `<output>`, and the count up by one. Clean up with `verify.ts cleanup web-wordpress`.

Timber isn't covered by launch-verify. `pnpm --filter cms-wordpress-timber run setup`, then expect 200 from `http://localhost:8090/`, `/about/`, `/programs/` and `/get-involved/` and no `Fatal error` or `Warning:` in the HTML or `docker compose logs wordpress`.

If Docker isn't available, say in the PR that the WordPress and Timber smokes didn't run. Don't skip the Payload smoke.

## When a bump breaks something

1. Find the package: the error usually names it. `pnpm why <pkg>` shows duplicate versions.
2. If the fix is a small, obvious code change in our code, make it in the same PR and say so.
3. Otherwise put that package (and anything that must move with it, like all `@payloadcms/*`) back to its old version, `pnpm install` (or `composer update <pkg>`), and rerun the failed check.
4. Add it to **Current holds** with the reason and the unblock condition, and list it in the PR body.

Never fix a break by loosening a pin, disabling a check, or editing a migration that has already run.

## Commits and PR

Commit in this order, each message ending with the session trailers your harness requires:

1. `Update JS dependencies to latest minor and patch releases` (package files, lockfiles, `.deepsec`, the changeset, holds named in the body).
2. `Update Composer dependencies for both WordPress installs` (`composer.json`, `composer.lock`).
3. Any runbook update (this file's holds table).

Make sure no commit contains a version you later held: fold the hold into the commit that introduced the bump. Push the branch and open the PR against `main`.

PR checklist:

- [ ] Every bump listed, old → new, per area (npm workspace, `.deepsec`, Composer headless, Composer Timber).
- [ ] Holds and their reasons; new holds added to the table above.
- [ ] Available majors from `pnpm deps:major` and `composer outdated` (`~`), not taken.
- [ ] `pnpm verify` and `pnpm build` passed on the final commit.
- [ ] Payload smoke passed on a fresh D1 (evidence directories named, screenshots uploaded, not committed).
- [ ] WordPress and Timber smokes passed, or the PR says why they didn't run.
- [ ] `git diff --name-only origin/main` shows no `wordpress-shared/*/composer.json`, no `Version:` header change, no `.github/`, no Wrangler config, no `packageManager` change.
- [ ] A changeset if a published package changed; nothing published, tagged or deployed.
- [ ] The project's standing review ran and P0/P1 findings are fixed.
