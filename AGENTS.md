# Project agent memory

Launch is Patronage's open-source monorepo of reference sites: vinext front-ends on Cloudflare Workers, powered by WordPress (headless over WPGraphQL, and a separate Timber install) and Payload, each with the CMS locked behind Cloudflare Access. It will be public, so everything committed, and every issue, PR and commit message, must be fit to publish.

## Rules

- **No third-party plugin or vendor code.** WordPress plugins and themes come in through Composer, and `composer-libs/`, `vendor/` and third-party `wp-content` folders are gitignored. Only Patronage's own `patronage-*` plugins, mu-plugins and themes are committed. The same applies to npm packages: depend on them, never copy them in.
- **No client references.** No client names, hostnames, ids, content, screenshots or credentials in code, fixtures, docs, commit messages, issues or PRs. Demo content is invented.
- **No Wrangler config files.** Do not add `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` (they are gitignored). Workers, bindings, secrets, Access applications and service tokens are created through the Cloudflare CLI and API by scripts in the repo.
- **No GitHub Actions.** Do not add workflows under `.github/`. Verification runs locally with `pnpm verify` before a PR is opened.
- **Shared UI takes plain props.** `packages/ui` knows nothing about WordPress or Payload. Each CMS has an adapter that maps its data to `packages/content-model`. Rich text and editor field definitions stay CMS-specific: adapters render rich text and pass it in as children. The Timber install shares design tokens only, not components.

## Layout

- `apps/*`: deployable apps (CMS installs, vinext front-ends, the MCP Worker, the docs-site).
- `packages/*`: shared libraries (content model, UI, Access helpers, MCP core and backends).
- `docs/`: engineering docs for contributors and agents. Spike findings go in `docs/spikes/`.

## Commands

Run from the repo root: `pnpm verify` is the full gate (frozen install, lint, typecheck, test). `pnpm lint` and `pnpm fix` use ultracite (oxlint + oxfmt). Dependencies only install versions older than `minimumReleaseAge` in `pnpm-workspace.yaml` (3 hours for now, moving to 72); update them with the `deps:*` scripts, whose taze reads the same window. Versions are pinned exactly (`savePrefix` in `pnpm-workspace.yaml`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project. Do not repeat what the codebase already shows; point to the authoritative file or command instead. Prefer rewriting or pruning existing entries over appending new ones.
