# ADR 0002: Plain pnpm workspaces with a release-age window

## Status

Accepted, 2026-10-29.

## Context

The repo has a handful of apps and packages. A task runner such as Turborepo adds config and caching behaviour that the repo does not need yet, and supply-chain attacks usually ship as fresh releases that are pulled within hours.

## Decision

- Plain pnpm workspaces (`pnpm -r`), no Turborepo or other task runner.
- pnpm 12, Node 24 (`.nvmrc`; Payload 4 needs 24.22+).
- Versions are pinned exactly (`savePrefix: ""`).
- `minimumReleaseAge` in `pnpm-workspace.yaml` is 180 minutes for now, so the spikes could start on new vinext releases. The goal is 4320 (72 hours).
- taze reads the same window; update dependencies with the root `deps:*` scripts.
- Install scripts are allowed per package in `allowBuilds`.

## Consequences

- A new dependency younger than the window will not install. Wait it out rather than lowering the window; an exception needs a stated reason in the PR.
- Raising the window to 72 hours is a one-line change once the stack settles.
