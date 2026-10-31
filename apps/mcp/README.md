# MCP gateway

The Worker a site's team installs as its one MCP server ([ADR 0014](../../docs/adr/0014-mcp-gateway-worker.md)). People sign in through Cloudflare Access, read the CMS as themselves, and change content only after a person approves the change.

It serves `/mcp` on its custom domain only, with no `workers.dev` or preview URLs.

## Tools

| Tool | What it does |
| --- | --- |
| `execute` | Runs JavaScript the model writes against the `wp` connector, in a Dynamic Worker with no network of its own. Reads return at once. Writes are staged and returned as a plan for approval. |
| `describe_site` | Summarizes the site's content types and REST routes, so the model knows what to ask for. |
| `get_run` | Reports a run's status after an approval. |

The `wp` connector reads WordPress REST and WPGraphQL as the signed-in person, and stages `update_post` operations (core fields and ACF fields, with an optional `expected_modified_gmt` check). Nothing is written until someone approves.

## Approvals

Every staged write pauses with a before-and-after. The person approves it in one of two places:

- an MCP Apps card inside the client, for clients that advertise MCP Apps support;
- the browser page at `/mcp/approvals/:id`, which works everywhere.

The approval runs as the approver, through the same Access sign-in. `APPROVAL_CSRF_SECRET` signs the approval tokens; without it every approval fails closed. The card's script is bundled at build time from `@modelcontextprotocol/ext-apps` (`pnpm generate`), so no vendor code is committed.

## Signing in

The Access application in front of this Worker must cover `/mcp*`, so the approval page is protected too. The Worker checks the `Cf-Access-Jwt-Assertion` header itself with `@patronage/access`, against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.

Calls to WordPress forward that JWT. WordPress's `patronage-access` mu-plugin (`wordpress-shared/patronage-access`) maps it to a WordPress user, and checks the gateway proof signed with `WORDPRESS_ACCESS_PROOF_SECRET`. When WordPress is itself behind Access, `WORDPRESS_ACCESS_CLIENT_ID` and `WORDPRESS_ACCESS_CLIENT_SECRET` hold the service token that gets requests through.

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

Text bindings come from the environment at build time (`WORKER_NAME`, `WORKER_DOMAIN`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `WORDPRESS_API_URL`, `DEPLOYMENT_ENVIRONMENT`). For `vite dev` and `vite preview`, put them in `.dev.vars` as well. The first deploy needs every secret in the environment; later deploys keep the stored values. `LOADER` needs the Workers paid plan (Dynamic Workers are in open beta).

## Still to come

- A `payload` connector that calls Payload's `/api/mcp` over a Service binding, with writes routed through approval.
- Splitting the transport, runtime and connectors into `packages/mcp-*`, published to npm under `@patronage`.
- Typed tool packs for named workflows.
