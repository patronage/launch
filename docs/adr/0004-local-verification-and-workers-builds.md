# ADR 0004: Local verification and Workers Builds, no GitHub Actions

## Status

Accepted, 2026-10-29.

## Context

CI in GitHub Actions would duplicate what Cloudflare Workers Builds already does for deploys and previews, and it would need its own copy of Cloudflare credentials.

## Decision

- No `.github/` workflows.
- `pnpm verify` (frozen install, lint, typecheck, test) is the gate, run locally before a PR is opened.
- Each Worker deploys from `main`, and builds previews for branches, through its own Cloudflare Workers Builds setup, configured by the app's `scripts/workers-builds.mjs`.
- The Workers Builds command runs the frozen install and lint for the whole repo, then typecheck and test only for that app and its dependencies, because the build image has no PHP.

## Consequences

- A PR's only automatic checks are the Workers Builds runs. Passing `pnpm verify` locally is the author's job.
- The recipe is in [spike 11](../spikes/11-workers-builds.md).
