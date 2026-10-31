# Spike: Payload's MCP plugin on Workers

Decision: [ADR 0014](../adr/0014-mcp-gateway-worker.md). Code: [`apps/payload/src/mcp.ts`](../../apps/payload/src/mcp.ts).

## Question

Can Payload's own MCP server (`@payloadcms/plugin-mcp`) run inside the Payload app under vinext on Workers with D1, so the MCP gateway can use it as its `payload` connector?

## Answer

Yes, in local workerd. The plugin builds with vinext and serves `POST /api/mcp` from the same Worker as the admin and the public pages. It reads through the Local API as the calling user. It adds about 70 KB to the gzipped Worker.

**Recommendation:** keep the plugin in `apps/payload`, read-only, and build the gateway's `payload` connector against it. Writes stay off in Payload. The gateway will add them behind its approval step.

## What was tested

Versions: `@payloadcms/plugin-mcp` and Payload 4.0.0-beta.6, vinext 1.4.0, Node 24.22, D1 locally, seeded demo content. Every request went to `vite preview`.

| Check | Result |
| --- | --- |
| `vite build` with the plugin | Pass |
| Worker size, gzipped JavaScript | 3.11 MB without the plugin, 3.18 MB with it |
| `initialize`, no credentials | Answers, but advertises no tools |
| `tools/list`, no credentials | Method not found, because no tool passes the default access check |
| Invalid `Authorization` header | `401` |
| `GET /api/mcp` | `405`, since the server keeps no stream open |
| `tools/list` as a signed-in editor | 10 read-only tools |
| `findDocuments` on `pages` and draft `posts` | Returns the documents |
| `findDocuments` on `users` and `form-submissions` | Refused: not enabled for that collection |
| `updateDocument` | Tool not found |

## How it is set up

- Every built-in tool that changes data is off for every collection and for the site settings global: create, update, delete, duplicate, upload preparation and version restore.
- `users` and `form-submissions` expose no tools at all. Submissions hold what visitors typed into forms.
- Payload's auth tools (login, password reset) are opt-in and stay off.
- The responses are plain JSON over Streamable HTTP, with no session state, so nothing needs a Durable Object.

## Signing in through Access

The plugin signs callers in with `payload.auth()`, so any auth strategy on the users collection applies. The users collection now gets `accessAuthStrategy` from `@patronage/access` when the Worker has `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. A request carrying a verified Access JWT is then signed in as the user with the same email. Without those variables, only Payload's own login works, as before.

Two type fixes were needed the first time this package met Payload. The strategy's loose Local API type does not match Payload's generated collection slugs, so `users.ts` pins the lookup to `users`. And the app's `tsconfig.json` now allows `.ts` import paths, as the other apps' do.

Not yet tested: the Access path end to end. It needs the Worker deployed with those variables set and an Access application in front of `/api`. The strategy itself is unit-tested in `packages/access`.

## What this means for the gateway

- The `payload` connector can call `/api/mcp` over a Service binding and forward the editor's Access JWT. A Service binding skips the Access edge, so the Payload Worker must check the gateway proof on that path before trusting the forwarded JWT.
- Tool results are text with JSON blocks, not structured content. The connector will parse them, or call Payload's custom-tool API to return JSON.
- Rich text comes back as Lexical JSON. A Markdown path for writes is still owed.
