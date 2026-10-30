# ADR 0008: A CMS-neutral content model with per-CMS adapters

## Status

Accepted, 2026-10-29.

## Context

Every Reference site renders the same Demo site. Sharing the UI only works if it does not know which CMS the content came from.

## Decision

- `packages/content-model` defines Pages, Sections, Blocks and Section options in plain TypeScript.
- Each CMS has an Adapter (`packages/adapter-wordpress`, `packages/adapter-payload`) that maps its data into the Content model.
- Rich text stays CMS-specific: the Adapter renders it and passes it in as children. Editor field definitions also stay in each CMS.
- `packages/ui` takes plain props and knows nothing about WordPress or Payload.
- A new Block goes into the Content model first, then into each CMS and Adapter. `packages/sections-preview` checks that both Adapters render the same output.

## Consequences

- Field names in each CMS follow the Content model (see [ADR 0010](0010-wordpress-fields-in-php.md)).
- See [spike 03](../spikes/03-cms-neutral-sections.md).
