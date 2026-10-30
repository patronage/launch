# ADR 0009: Shared UI on shadcn/ui and Tailwind 4

## Status

Accepted, 2026-10-30.

## Context

The first Front-ends used hand-written CSS and looked unlike Patronage's other sites, which build on shadcn/ui with shared Section, Container and Typography primitives.

## Decision

- `packages/ui` is built on shadcn/ui and Tailwind 4.
- Pages are composed from its `Section`, `Container` and `Typography` primitives and shadcn components, not app-local CSS.
- New shadcn components are added to the package, not to an app (see `packages/ui/README.md`).
- `tokens.css` stays Tailwind-free so the Timber install can load it.

## Consequences

- Each app adds `@tailwindcss/vite` and one CSS file that imports `@launch/ui/styles.css`.
- Payload's admin is untouched; Tailwind applies only to the public routes.
