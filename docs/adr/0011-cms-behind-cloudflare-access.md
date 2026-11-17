# ADR 0011: Every CMS behind Cloudflare Access

## Status

Accepted, 2026-10-29. Corrected 2026-11-09 to describe the Timber install.

## Context

The point of Launch is to show a CMS that is not reachable from the public internet, while its Front-end stays fast and public.

## Decision

- Each CMS's admin and API sit behind a Cloudflare Access application. Only the Front-end is public.
- Front-ends and the MCP Worker that reach a locked CMS over the network read with an Access Service token. A Service token never maps to a CMS user, so it can only read.
- The Payload Front-end runs in the same Worker as the CMS and reads through the Local API, so it needs no Service token; Access locks only `/admin` and `/api` there.
- `packages/access` (`@patronage/access`) holds JWT verification, the Access-aware fetch, the Payload auth strategy and the provisioning script.
- `wordpress-shared/patronage-access` is the WordPress mu-plugin that verifies Access JWTs, configured with `PATRONAGE_ACCESS_*` constants. Each of its jobs (origin guard, browser login, gateway identity) is off until its constants are set.
- The Timber install is its own Front-end, because WordPress serves the public site. Access there protects only `/wp-admin` and `/wp-login.php`, not the hostname. The install does not ship `patronage-access`; one that wants editors to skip the WordPress login form after Access can add it with only browser login on, leaving the origin guard off.

## Consequences

- New code that talks to a CMS reuses these packages instead of porting its own checks.
- See [spike 05](../spikes/05-access-lockdown.md).
