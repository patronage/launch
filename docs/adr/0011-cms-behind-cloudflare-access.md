# ADR 0011: Every CMS behind Cloudflare Access

## Status

Accepted, 2026-10-29.

## Context

The point of Launch is to show a CMS that is not reachable from the public internet, while its Front-end stays fast and public.

## Decision

- Each CMS's admin and API sit behind a Cloudflare Access application. Only the Front-end is public.
- Front-ends and the MCP Worker read from a locked CMS with an Access Service token. A Service token never maps to a CMS user, so it can only read.
- `packages/access` (`@patronage/access`) holds JWT verification, the Access-aware fetch, the Payload auth strategy and the provisioning script.
- `wordpress-shared/patronage-access` is the WordPress mu-plugin that verifies Access JWTs, configured with `PATRONAGE_ACCESS_*` constants.

## Consequences

- New code that talks to a CMS reuses these packages instead of porting its own checks.
- See [spike 05](../spikes/05-access-lockdown.md).
