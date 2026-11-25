# ADR 0027: The EmDash connector's reads, writes and sign-in

## Status

Accepted, 2026-11-25. Extends [ADR 0014](0014-mcp-gateway-worker.md) and [ADR 0022](0022-emdash-renders-the-site-in-astro.md). Tracked in [issue #188](https://github.com/patronage/launch/issues/188).

## Context

The gateway has connectors for WordPress and Payload. Launch's third CMS, EmDash 1.6, has no connector, so the team can't use its own MCP server on the EmDash demo.

EmDash has an MCP endpoint of its own at `/_emdash/api/mcp`, but it accepts only an OAuth access token or a personal API token sent as `Authorization: Bearer`. A Cloudflare Access session doesn't reach it, so the gateway would need a second sign-in per editor. EmDash's REST API under `/_emdash/api/` accepts any signed-in session, answers `{ success: true, data }` or `{ error: { code, message } }`, and is what EmDash's own admin uses.

EmDash signs editors in through an auth provider. The stock `@emdash-cms/cloudflare` provider reads only `Cf-Access-Jwt-Assertion`, checked against the admin's own Access application. The gateway forwards the editor's Access JWT for its own application in `X-Access-User-Jwt`, beside a proof signed with a secret EmDash shares, as it does for WordPress and Payload. On a sign-in EmDash's middleware creates a user it doesn't know (with the provider's default role), updates the user's name, and starts a session.

## Decision

- **Sign-in.** `apps/emdash` adds an auth provider, `src/auth/gateway-access.ts`, set as the `access(...)` provider's `entrypoint` when `ACCESS_GATEWAY_AUD` is set at build time. A request without `X-Access-User-Jwt` goes to the stock provider unchanged. A request with one must carry a valid gateway proof (`ACCESS_GATEWAY_PROOF_SECRET`) for that exact token, checked before the JWT; the JWT is then checked against the gateway's audience (`ACCESS_GATEWAY_AUD`) and the team's issuer, a service token's identity is refused, and the name and groups come from Access's `get-identity` for the same token. The check is `verifyForwardedUser` in `@patronage/access`, so another CMS can share it. Without the proof the forwarded header is never trusted.
- **Transport.** The gateway reaches EmDash over a Service binding (`EMDASH_WORKER`) or by URL through Access with a service token (`EMDASH_API_URL`), the same two ways as Payload. Every request sends `X-EmDash-Request: 1`, which EmDash requires on unsafe methods.
- **Reads.** `emdash.get({ path, query? })` reads the REST API, not EmDash's MCP endpoint. Only an allowlist of routes is readable: content, revisions, schema, media, menus, taxonomies and search. Users, tokens, settings, plugins, imports and exports, edit locks and the authors list are refused. `describe_site` lists the collections with their fields and what each supports, the taxonomies, and the editor's role.
- **Writes, next.** `emdash.apply` will stage `update_draft` (a `PUT` with `status: "draft"` and the `_rev` the model read, so a newer edit fails rather than being overwritten), `create_draft` and `publish` operations, held for approval where the deployment requires it. Rich text can be written as Markdown through `emdash/client`'s `markdownToPortableText`. A collection without `drafts` in its `supports` (the demo's `category_details`) saves live, so its operations must say so, as Payload's globals do.

## Consequences

- A person in the gateway's Access policy who has never signed in to EmDash gets an EmDash user on their first gateway call, with the default role (author). Access policies, not EmDash, decide who can reach it, as they do for the admin.
- Every gateway call to EmDash signs in afresh and writes a session, as a browser sign-in through Access does. Calls are few enough that this is acceptable; a cache can come later.
- Under `astro dev`, EmDash skips external auth, so the gateway path only runs in a built Worker (`astro build` and `astro preview`, or a deploy).
- `@patronage/mcp-emdash` is a published package like the other connectors, and joins the npm publish workflow (ADR 0025).
