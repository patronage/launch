# Launch

## What this codebase does

Launch is a reference-site monorepo, not a multi-tenant service. Headless WordPress exposes WPGraphQL to a vinext Front-end on Cloudflare Workers. Payload 4 runs its CMS and public Front-end in one Worker, with D1 by default and optional Postgres through Hyperdrive. Shared React UI receives plain data from CMS Adapters. WordPress code is PHP; Workers and tooling are TypeScript, JavaScript and shell. Timber WordPress and the MCP Worker are planned, not built.

## Auth shape

- `packages/access/src/jwt.ts`: `verifyAccessJwt` checks RS256, issuer, audience, expiry and identity. User identities and Service tokens differ.
- `accessAuthStrategy` maps a verified user email to an existing Payload user. A Service token must never become an editor or gain write access.
- `wordpress-shared/patronage-access` verifies Access assertions and forwarded user JWTs. Trace gateway proof and service identity before accepting headers.
- Access locks Payload `/admin` and `/api`; public routes and `/next` handlers require their own appropriate controls. WordPress has a separate CMS origin.
- Preview links/cookies, revalidation secrets and media proxying cross the public Front-end/CMS boundary. Verify them at the actual route handlers.

## Threat model

Prioritize anonymous or Service-token access to CMS writes, administrative sessions and unpublished content. Consider attacker-controlled URL paths, queries, headers, form submissions, uploads and CMS-authored rich text. A compromised editor must not gain server execution or expose server credentials. Treat documented Cloudflare protections as assumptions to trace through the provisioning and Worker code, not proof that a route is safe in production.

## Project-specific patterns to flag

- Payload Local API `overrideAccess: true` reachable with untrusted input; distinguish internal identity lookup from public draft or secret disclosure.
- `/next/local-login` and `isLocalRequest`: prove remote callers and shared tunnels cannot obtain the first user's session by forging request headers.
- WordPress preview/revalidation handlers: verify signatures, expiry, authorization, redirect targets and cache invalidation scope.
- Media fetches and rich-text/link rendering: trace origin allowlists, URL resolution, redirects, escaping and credentials across Adapter boundaries.
- Deploy/provision scripts: trace shell arguments, archive paths and secret handling. Report deployment exposure separately from remotely reachable bugs.

## Known false-positive sources

- Seed content and `.env.example` contain invented demo values. They are not production credentials, but production paths must not rely on demo passwords.
- Public published Pages and Media reads are intentional. Drafts, Users, submissions and CMS mutations still need their own authorization checks.
- Tests contain forged JWTs, hostile URLs and bypass attempts as negative cases. Follow production call sites before reporting a test fixture as exploitable.
- Local login is intentional only on a developer's machine. Its stated intent is not an exemption: establish whether the localhost restriction holds.
- The WordPress adapter explicitly trusts editor-authored HTML (docs/spikes/03-cms-neutral-sections.md). Distinguish that documented trust decision from a lower-trust author gaining script execution; report the impact and prerequisites accurately.

## Verified platform context (2026-11-03)

Cloudflare Images binding billing counts each unique source-image/parameter combination once per calendar month. Repeated requests for the same transformation do not incur additional transformation usage. Query parameters ignored by Launch's image handlers do not change the binding's fixed width/quality or its three possible output formats. Missing caching can still increase processing work and origin traffic; evaluate those effects separately from a claim of unlimited per-request transformation billing. Source: [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/) (checked 2026-11-03).
