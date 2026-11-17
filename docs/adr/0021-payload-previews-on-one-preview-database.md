# ADR 0021: Payload Previews on one preview database, with a schema only for branches that add migrations

## Status

Accepted, 2026-11-13. Changes the "no Previews" part of [ADR 0020](0020-payload-production-on-planetscale.md) for Postgres; the rest of 0020 stands.

## Context

Every PR should get a preview URL whose content resembles the live site. Most PRs change no Payload schema. Some add migrations, and those must not change the schema other previews read. A PlanetScale branch per PR would cost an instance per PR, and a Hyperdrive configuration can point at only one database. So a database per PR would also mean a configuration per PR, or previews that skip Hyperdrive.

## Decision

- One PlanetScale branch, `preview`, on `launch-payload`, at the smallest single-node size, holds every preview. One Hyperdrive configuration points at it.
- Its `public` schema is the shared preview copy: content copied from production, plus preview editors, who are not production's users. A branch that adds no migrations reads `public`, so it costs nothing beyond its Worker Preview.
- A branch that adds migrations gets its own schema, `preview_<12 hex digits of sha256(branch)>`. `node scripts/preview-schema.mjs prepare --branch <name>` creates it before the build:
  1. It migrates the new schema to `public`'s level.
  2. It copies every row of `public` into the new schema within the same database. Users come along; sessions, locks and the key-value cache don't.
  3. It runs the branch's own migrations on top.

  Later builds of the branch migrate the schema in place. A schema whose migrations no longer match the branch is rebuilt.

- The Worker is built with `PAYLOAD_DB_SCHEMA` set to that schema. Payload's `schemaName` names it on every query, so the preview still reads through the shared Hyperdrive configuration. A Worker built for a schema runs no migrations at boot: through Hyperdrive, their DDL would land in `public`.
- Committed Postgres migrations name no schema. `payload migrate:create` writes `"public".` before enum and foreign-key names; that prefix is deleted, and a test fails while any migration has it. Production and `public` still get every object, because search_path is `public` there. A branch schema gets them because `prepare` migrates it with `search_path` set to the schema.
- `prepare` refuses a database whose `launch_preview` schema `init` has not created. That schema also records each branch schema with the time it was last prepared, so `sweep --days <n>` can drop stale ones and `drop --branch` removes one.
- What the scripts create belongs to `postgres`. Payload's migrations connect as the role in `PREVIEW_DATABASE_URL`, and PlanetScale ignores a `role` startup option, so `prepare` reassigns that role's objects to `postgres`. Otherwise PlanetScale would refuse to delete the role later.

## Consequences

- A Postgres preview build needs `PREVIEW_DATABASE_URL`: a direct connection, as a role that inherits `postgres`, on the `preview` branch only. It is a secret build variable on the Workers Builds trigger.
- Edits made in a preview that reads `public` change the shared copy until its next refresh. Edits in a branch schema stay there.
- A branch that adds migrations but lacks some of `public`'s must merge `main` first, and its migrations must sort after `public`'s newest.
- Refreshing `public` from production is a separate, attended step. It is the only step that reads production. It copies the `content` tables in `db-pull.tables` and keeps the preview's own users.
- Previews on D1 keep their own D1 database, as before.
