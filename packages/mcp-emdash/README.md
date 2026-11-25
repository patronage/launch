# @patronage/mcp-emdash

The EmDash connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `emdash`:

- `emdash.get({ path, query? })` GETs an EmDash REST path under `/_emdash/api/` as the signed-in editor, with that editor's EmDash role, and returns the response's `data`. It reads content (lists, one entry, revisions, compare, translations, terms, references and trash), revisions, schema, media, menus, taxonomies and search. Every other route is refused, the admin's users, tokens, settings, plugins, imports and edit locks included.
- `describe_site` lists the collections the editor can see, with their fields and what each supports (drafts, revisions, preview), the taxonomies, and the editor's role.

It does not write yet. Draft writes are the next step (ADR 0027).

## What the EmDash site needs

EmDash's own MCP endpoint (`/_emdash/api/mcp`) accepts only OAuth or personal API tokens, so the connector uses the REST API instead. EmDash has to trust the Cloudflare Access JWT the gateway forwards in `X-Access-User-Jwt`, which the stock `@emdash-cms/cloudflare` provider doesn't read. `apps/emdash/src/auth/gateway-access.ts` is a drop-in auth provider: it checks the gateway proof with `verifyForwardedUser` from `@patronage/access` before it accepts the forwarded JWT, and falls back to the stock provider for an editor in the browser. Copy it into the site and point `access(...)`'s `entrypoint` at it, as `apps/emdash/astro.config.mjs` does when `ACCESS_GATEWAY_AUD` is set.

The EmDash Worker then needs:

- `ACCESS_GATEWAY_AUD`: the audience of the gateway's own Access application, which is what the forwarded JWT carries.
- `ACCESS_GATEWAY_PROOF_SECRET` (secret): the same value as the gateway's `EMDASH_ACCESS_PROOF_SECRET`.

## Gateway bindings

- `EMDASH`: a Service binding to the EmDash Worker, or `EMDASH_API_URL`, EmDash's public origin, reached through its Access application with the service token in `EMDASH_ACCESS_CLIENT_ID` and `EMDASH_ACCESS_CLIENT_SECRET`. One of the two turns the connector on.
- `EMDASH_ACCESS_PROOF_SECRET` (required): signs the gateway proof.
- `EMDASH_ADMIN_URL`: EmDash's public origin, for links into its admin.

```ts
import { emdashConnector } from "@patronage/mcp-emdash";

const connectors = [emdashConnector];
```
