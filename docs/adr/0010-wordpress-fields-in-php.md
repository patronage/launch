# ADR 0010: WordPress fields and post types in PHP

## Status

Accepted, 2026-10-29. Fields moved to `wordpress-shared/patronage-fields` by ADR 0015.

## Context

Field groups built in the ACF admin and synced as JSON are hard to review and drift between environments. ACF Pro also needs a licence, which would stop someone running the public repo.

## Decision

- Fields are defined in PHP with `vinkla/extended-acf`, in the theme's `fields/` folder. JSON sync is off.
- Post types and taxonomies are defined in PHP with `johnbillion/extended-cpts`.
- The field plugin is Secure Custom Fields, the free GPL fork of ACF, so no licence is needed. (This is not the ACF Extended plugin.)
- Page Builder layout and field names follow the Content model.

## Consequences

- After a field change, regenerate the GraphQL schema and the Adapter's types (`pnpm --filter web-wordpress codegen:schema`, then `pnpm --filter @launch/adapter-wordpress codegen`).
- `vinkla/extended-acf` stays on 14.x until the install moves to PHP 8.4.
