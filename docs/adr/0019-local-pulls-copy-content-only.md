# ADR 0019: Local database pulls copy content only

## Status

Accepted, 2026-11-13.

## Context

Launch sites are moving to Postgres on PlanetScale, behind Hyperdrive. Developers need real content locally to work on pages and sections. A plain dump would also copy users with their password hashes and API keys, sessions, and visitors' form submissions onto laptops.

## Decision

- `packages/db-pull` (`pull-postgres.sh`) is the one pull for PlanetScale Postgres. An app keeps only its `db-pull.env`, its `db-pull.tables` and an optional after-script, and runs it as `pnpm db:pull`.
- A pull reads through a temporary PlanetScale role that inherits only `pg_read_all_data`, expires after 30 minutes and is deleted as soon as the dump ends. It never writes to PlanetScale.
- The rows copied are an allowlist: the `content` tables in `db-pull.tables`. Every other table arrives empty, including any table the list does not name. Links from content to rows that were not copied are cleared before the foreign keys are made, and the copy is checked before it replaces the local database.
- Users never leave PlanetScale. A developer creates a local first user on `localhost`.
- The pull writes only to a Postgres on the developer's own machine, through a local Docker daemon.
- An app's test fails when its schema has a table that `db-pull.tables` does not classify.

## Consequences

- A new collection, field or plugin table needs a line in `db-pull.tables`, and a table that holds anything about a visitor or a user is `excluded`.
- Media files are not pulled; they stay in the app's bucket.
- The pull needs the `pscale` CLI signed in as someone who may manage roles on the database, so it runs on a person's machine, not in CI.
- WordPress keeps `wp-deploy`'s `pull.sh` until a site runs WordPress on PlanetScale.
