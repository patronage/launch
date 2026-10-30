# ADR 0006: Separate headless and Timber WordPress installs

## Status

Accepted, 2026-10-29. The Timber install is not built yet.

## Context

A single WordPress install could serve both a headless Front-end and a Timber theme, but the two need different plugins, themes, caching and deploy steps, and mixing them makes each harder to copy.

## Decision

- `apps/cms-wordpress-headless` is WordPress with WPGraphQL and no public theme output, feeding `apps/web-wordpress`.
- `apps/cms-wordpress-timber` will be a separate, traditional install whose Timber theme renders the site.
- The Timber install shares Design tokens from `packages/ui` only, not React components.
- Plugins and libraries for both come in through Composer and are never committed.

## Consequences

- Each install can be copied to a new project on its own.
- Shared WordPress code (the Access mu-plugin, the deploy kit) lives in `wordpress-shared/`, not in either install.
