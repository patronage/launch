# @patronage/mcp-emdash

The EmDash connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `emdash`:

- `emdash.get({ path, query? })` GETs an EmDash REST path under `/_emdash/api/` as the signed-in editor, with that editor's EmDash role, and returns the response's `data`. It reads content (lists, one entry, revisions, compare, translations, terms, references and trash), revisions, schema, media, menus, taxonomies and search. Every other route is refused, the admin's users, tokens, settings, plugins, imports and edit locks included.
- `describe_site` lists the collections the editor can see, with their fields and what each supports (drafts, revisions, preview), the taxonomies, and the editor's role.

- `emdash.apply({ intent, operations })` writes, held for approval where the gateway requires it, with up to 20 operations, one per entry:
  - `update_draft` (`collection`, `id`, `fields`, optional `expected_rev`) saves the fields as a draft revision. The public site is unchanged.
  - `create_draft` (`collection`, `fields`, optional `slug`) adds a new entry as a draft.
  - `publish` (`collection`, `id`, optional `expected_rev`) puts the entry's draft on the public site. Its approval page says so.

  `fields` names top-level field slugs. A rich text field takes a whole Portable Text array; Markdown isn't converted. Each write sends the `_rev` the preview read, so an entry someone saved since fails with `CONFLICT` instead of being overwritten. The preview refuses an unknown field, a slug in place of an entry id, a stale `expected_rev`, and `update_draft` on a collection without `revisions` (EmDash would save it live). Each receipt carries the entry's `id`, its new `rev`, its `status` and an admin link. EmDash's own permissions and plugins apply: an author can draft their own entries but not change anyone else's, and a plugin can refuse a publish (the Launch demo's news stories need a category, which the connector doesn't set).

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
