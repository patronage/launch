# MCP gateway

The Worker a site's team installs as its one MCP server ([ADR 0014](../../docs/adr/0014-mcp-gateway-worker.md)). People sign in through Cloudflare Access, read the CMS as themselves, and change content only after a person approves the change.

It serves `/mcp` on its custom domain only, with no `workers.dev` or preview URLs.

## Tools

| Tool | What it does |
| --- | --- |
| `execute` | Runs JavaScript the model writes against the `wp` connector, in a Dynamic Worker with no network of its own. Reads return at once. Writes are staged and returned as a plan for approval. |
| `describe_site` | Summarizes the site's content types and REST routes, so the model knows what to ask for. On a site with Payload it also lists the collections the editor can read, which keep drafts, and which fields take Markdown. |
| `get_run` | Reports a run's status after an approval. |

The `wp` connector reads WordPress REST and WPGraphQL as the signed-in person, and stages `update_post` operations (core fields and ACF fields, with an optional `expected_modified_gmt` check). `wp.graphql` runs queries only, and `wp.get` refuses method overrides. Nothing is written until someone approves.

On a site with Payload, the `payload` connector sits beside it:

- `payload.tools()` and `payload.call({ tool, arguments })` run Payload's own read tools at `/api/mcp` as the signed-in editor. Only the read tools are allowed, whatever Payload's config says.
- `payload.apply({ intent, operations })` stages `update_draft` operations (top-level fields of one document, with an optional `expected_updated_at` check) and `create_draft` operations (a new document). After approval each one is saved through Payload's REST API with `?draft=true`, so nothing is published until someone publishes in the Payload admin. Collections without drafts are refused, and so are `_status`, `id` and the timestamps.
- Rich text fields can be written as Markdown, in an operation's `markdown` instead of `fields`. Payload converts it with that field's own editor features, through the read-only `markdownToRichText` and `richTextToMarkdown` tools that `apps/payload` adds, and the approval preview shows Markdown on both sides. A field whose Markdown is unchanged is not rewritten, and a Markdown edit is refused when the stored value holds nodes Markdown cannot carry (rich text blocks, uploads), since writing it back would delete them.

## Approvals

Every staged write pauses with a before-and-after. The person approves it in one of two places:

- an MCP Apps card inside the client, for clients that advertise MCP Apps support;
- the browser page at `/mcp/approvals/:id`, which works everywhere.

The approval runs as the approver, through the same Access sign-in. `APPROVAL_CSRF_SECRET` signs the approval tokens; without it every approval fails closed. The card's script is bundled at build time from `@modelcontextprotocol/ext-apps` (`pnpm generate`), so no vendor code is committed.

## Signing in

The Access application in front of this Worker must cover `/mcp*`, so the approval page is protected too. The Worker checks the `Cf-Access-Jwt-Assertion` header itself with `@patronage/access`, against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.

Calls to WordPress and Payload forward that JWT. WordPress's `patronage-access` mu-plugin (`wordpress-shared/patronage-access`) maps it to a WordPress user, and checks the gateway proof signed with `WORDPRESS_ACCESS_PROOF_SECRET`. When WordPress is itself behind Access, `WORDPRESS_ACCESS_CLIENT_ID` and `WORDPRESS_ACCESS_CLIENT_SECRET` hold the service token that gets requests through.

Payload is reached one of two ways. With `PAYLOAD_WORKER` set at build time, a Service binding calls the Payload Worker directly. With `PAYLOAD_API_URL` instead, requests go through Payload's Access application with the service token in `PAYLOAD_ACCESS_CLIENT_ID` and `PAYLOAD_ACCESS_CLIENT_SECRET`. Either way Payload checks the proof signed with `PAYLOAD_ACCESS_PROOF_SECRET`, which must match `ACCESS_GATEWAY_PROOF_SECRET` on the Payload Worker. `PAYLOAD_ADMIN_URL` gives the approval page its "open in Payload admin" link. With neither set, the `payload` connector is left out.

## Logging

Each request writes one evlog wide event to Workers Logs: the opaque actor (a hash, never the email or subject), the tool, the outcome and any write receipts. A request with no Access JWT is logged as `challenged`, not `denied`, because a client that has not signed in yet sends one first. Workers Logs keep events for seven days. A weekly usage report is future work (see the docs site's MCP reference).

## Commands

```sh
pnpm dev        # vite dev with the Cloudflare plugin
pnpm build      # generate the approval card, then vite build
pnpm test       # unit tests (the live code-mode test is skipped without a loader)
pnpm typecheck
pnpm deploy     # build and cf deploy; pass --dry-run to check without uploading
```

Text bindings come from the environment at build time (`WORKER_NAME`, `WORKER_DOMAIN`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `WORDPRESS_API_URL`, `DEPLOYMENT_ENVIRONMENT`, and for Payload `PAYLOAD_WORKER` or `PAYLOAD_API_URL`, plus `PAYLOAD_ADMIN_URL`). For `vite dev` and `vite preview`, put them in `.dev.vars` as well. The first deploy needs every secret in the environment; later deploys keep the stored values. `LOADER` needs the Workers paid plan (Dynamic Workers are in open beta).

## Still to come

- Logging Payload's requests under their own name rather than beside WordPress's.
- Splitting the transport, runtime and connectors into `packages/mcp-*`, published to npm under `@patronage`.
- Typed tool packs for named workflows.
