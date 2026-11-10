# Project agent memory

Launch is Patronage's public, open-source monorepo of reference sites: vinext front-ends on Cloudflare Workers, powered by WordPress (headless over WPGraphQL, and a separate Timber install) and Payload, each with the CMS locked behind Cloudflare Access. Everything committed, and every issue, PR and commit message, must be fit to publish.

## Rules

- **No third-party plugin or vendor code.** WordPress plugins and themes come in through Composer, and `composer-libs/`, `vendor/` and third-party `wp-content` folders are gitignored. Only Patronage's own `patronage-*` plugins, mu-plugins and themes are committed. The same applies to npm packages: depend on them, never copy them in.
- **No client references.** No client names, hostnames, ids, content, screenshots or credentials in code, fixtures, docs, commit messages, issues or PRs. Demo content is invented.
- **Security findings stay private until approved.** Report suspected or confirmed vulnerabilities to Cameron in this chat and keep evidence in ignored local storage. Read [Handling security findings](docs/agents/security-findings.md) before publishing a finding or remediation.
- **No Wrangler config files.** Do not add `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` (they are gitignored). Workers, bindings, secrets, Access applications and service tokens are created through the Cloudflare CLI and API by scripts in the repo.
- **No GitHub Actions.** Do not add workflows under `.github/`. Verification runs locally with `pnpm verify` before a PR is opened.
- **Shared UI takes plain props.** `packages/ui` knows nothing about WordPress or Payload. Each CMS has an adapter that maps its data to `packages/content-model`. Rich text and editor field definitions stay CMS-specific: adapters render rich text and pass it in as children. The Timber install shares design tokens only, not components.
- **Front-end UI is shadcn/ui on Tailwind 4, in `packages/ui`.** Build pages from its `Section`, `Container` and `Typography` primitives and shadcn components rather than app-local CSS; add new shadcn components to the package (see `packages/ui/README.md`).
- **Published packages need a changeset.** A PR that changes `src/` or `package.json` in `@patronage/access` or an `@patronage/mcp-*` package adds one with `pnpm changeset`; `pnpm verify` fails without it. See [.changeset/README.md](.changeset/README.md).
- **Update the public docs in the same PR.** If a PR changes what a reader of the docs site (`apps/docs-site`, live at launch.patronage.com) would run, deploy, configure or decide, such as a new app, package, command, deploy step or decision, update the affected pages under `apps/docs-site/docs` in that PR. Spike notes publish themselves; ADRs and READMEs don't, so summarize a new decision on the site's Decisions page. Run `pnpm --filter docs-site test` to check links.

## Layout

- `apps/*`: deployable apps (CMS installs, vinext front-ends, the MCP Worker, the docs-site).
- `packages/*`: shared libraries (content model, UI, Access helpers, MCP core and backends).
- `wordpress-shared/*`: Patronage WordPress code both installs load, and the `wp-deploy` kit.
- `docs/`: engineering docs for contributors and agents. Decisions go in `docs/adr/`, spike findings in `docs/spikes/` (which the public docs site, `apps/docs-site`, publishes as written; ADRs stay in the repo), and agent skill config in `docs/agents/`.
- `GLOSSARY.md`: the domain vocabulary. Use its terms in code, issues and PRs.

## Agent skills

### Issue tracker

GitHub issues in `patronage/launch`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Local verification

`.agents/skills/launch-verify` (linked from `.claude/skills`) launches the Payload or web-wordpress front end locally, drives real pages and forms in a browser, and keeps screenshots as evidence. Use it to prove a UI change before opening a PR; `pnpm verify` alone isn't that proof.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/`. Read both before domain work, and flag any conflict with an ADR. See `docs/agents/domain.md`.

### Security review

DeepSec setup, containment and review limits are in [.deepsec/README.md](.deepsec/README.md). `pnpm security:scan` scans a committed snapshot without model access.

## Commands

Run from the repo root: `pnpm verify` is the full gate (frozen install, lint, typecheck, test). `pnpm lint` and `pnpm fix` use ultracite (oxlint + oxfmt). Dependencies only install versions older than `minimumReleaseAge` in `pnpm-workspace.yaml` (3 hours for now, moving to 72); update them with the `deps:*` scripts, whose taze reads the same window. Versions are pinned exactly (`savePrefix` in `pnpm-workspace.yaml`). Shared dependencies (React, Vite, Vitest, `@types/node`) come from the `catalog` in `pnpm-workspace.yaml`: list them as `"catalog:"`, never a version.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project. Do not repeat what the codebase already shows; point to the authoritative file or command instead. Prefer rewriting or pruning existing entries over appending new ones.
