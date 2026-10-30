# ADR 0007: Payload as one app on D1

## Status

Accepted, 2026-10-29.

## Context

The earlier Payload reference ran Next.js and Payload on Vercel with Postgres. On Workers, Payload can run in the same Worker as the Front-end and read content through its Local API, with no HTTP hop.

## Decision

- `apps/payload` is one vinext app: Payload admin, API and the public Front-end together, reading through the Local API.
- It uses the Payload 4 beta.
- The database is Cloudflare D1 by default. Postgres through Hyperdrive stays in the code as an option (`PAYLOAD_DB=postgres`), to compare later.
- Migrations run everywhere; schema push is off.

## Consequences

- Access locks only `/admin` and `/api`, so the public pages stay open on the same hostname.
- `vite dev` does not work yet; the local loop is build plus preview. See [spike 05](../spikes/05-payload-on-vinext.md).
