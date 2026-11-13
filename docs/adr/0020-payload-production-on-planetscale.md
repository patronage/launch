# ADR 0020: Payload production on Postgres through Hyperdrive and PlanetScale

## Status

Accepted, 2026-11-13. Replaces the database part of [ADR 0007](0007-payload-single-app-on-d1.md); the rest of 0007 stands. [ADR 0021](0021-payload-previews-on-one-preview-database.md) adds Previews on Postgres.

## Context

ADR 0007 chose D1 for the Payload app and kept Postgres through Hyperdrive as an option to compare later. Most Launch sites will run Postgres on PlanetScale behind Hyperdrive, and local work now pulls content from PlanetScale (ADR 0019). The reference app should run the way those sites will. The Payload code already runs on Postgres with `PAYLOAD_DB=postgres`, and the D1 and Postgres migrations build the same tables and columns.

## Decision

- Production Payload uses the PlanetScale Postgres database `launch-payload`, branch `main`, through one Hyperdrive configuration made with Hyperdrive's managed PlanetScale integration. Query caching is off, because the admin reads what it has just written.
- `pnpm run hyperdrive:configure` creates or finds that configuration and turns caching off. The Workers Builds trigger builds with `PAYLOAD_DB=postgres` and `HYPERDRIVE_ID`.
- The move copies D1 into a freshly migrated PlanetScale branch with `pnpm d1:copy`: every table but sessions, document locks and the key-value cache, with the same ids, in one transaction that commits only when every table's row count matches D1. It only reads D1.
- D1 stays as it was after the copy, so going back is setting `PAYLOAD_DB` back to `d1` on the trigger and rebuilding. The D1 database is deleted only after Postgres has run for a while, and only with Cameron's go.
- Production only for now: no PlanetScale staging branch and no Previews. Local work uses `pnpm db:pull`. A `staging` branch with its own Hyperdrive configuration (`hyperdrive:configure --branch staging`) can be added later, seeded rather than copied from production.
- D1 stays the default for local work and new apps until the next decision, since it needs no Docker.

## Consequences

- Editors sign in again after the switch, because sessions are not copied.
- Content written to D1 after the copy is not in Postgres: editing pauses from the copy to the switch.
- Payload Previews still need their own D1 database, so they stay off while production runs on Postgres.
- Media stays in R2.
