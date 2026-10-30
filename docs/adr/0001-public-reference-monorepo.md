# ADR 0001: One public reference monorepo

## Status

Accepted, 2026-10-29.

## Context

Patronage's earlier reference work was spread across several `launch-*` repos, and one of them committed paid plugins and thousands of third-party files. The goal now is an open-source set of Reference sites that anyone can run, with hosted demos.

## Decision

Launch is one public monorepo, started from a fresh snapshot with no imported git history.

- `apps/*` holds deployable apps, `packages/*` shared libraries, and `wordpress-shared/*` Patronage's own WordPress plugins and tooling.
- No third-party plugin, theme or vendor code is committed. WordPress plugins come in through Composer; npm packages are dependencies, never copies.
- No client references anywhere: code, fixtures, docs, issues, PRs or commit messages. The Demo site is invented.
- Engineering docs live in `docs/` (this folder, `docs/agents/`, `docs/spikes/`). Public docs are the `apps/docs-site` Blume site, which publishes `docs/spikes/` as written.

## Consequences

- Everything an agent writes, including issue and PR text, must be fit to publish.
- Plugins that are not on Packagist are installed from their GitHub release zips through Composer `package` repositories.
- Free, GPL software is preferred where a paid option would stop someone running the repo (see [ADR 0010](0010-wordpress-fields-in-php.md)).
