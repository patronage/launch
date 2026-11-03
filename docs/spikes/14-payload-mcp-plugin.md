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

Tested locally against a stand-in Access key server (a local JWKS at `/cdn-cgi/access/certs`, with `ACCESS_TEAM_DOMAIN` pointing at it):

| Check | Result |
| --- | --- |
| `tools/list` with a valid Access JWT for a known editor | 10 tools |
| Same, for an email with no Payload user | No tools |
| `/api/users/me` with an Access JWT | The editor, signed in by `cloudflare-access` |
| Admin session refresh with the session cookie and an Access JWT | `200`; Payload's own session wins |

The strategy steps aside whenever a request already carries Payload's own credential (the session cookie or an `Authorization` header). Payload 4.0.0-beta.6 runs its built-in strategies first anyway, so this only guards against that order changing: a user signed in through Access has no session id, and Payload would refuse to refresh the admin's session. Still to check on the deployed Worker: a real Access application in front of `/api`.

## What this means for the gateway

- The `payload` connector can call `/api/mcp` over a Service binding and forward the editor's Access JWT. A Service binding skips the Access edge, so the Payload Worker must check the gateway proof on that path before trusting the forwarded JWT.
- Tool results are text with JSON blocks, not structured content. The connector will parse them, or call Payload's custom-tool API to return JSON.
- Rich text comes back as Lexical JSON. A Markdown path for writes is still owed.

Follow-up: the `payload` connector in `apps/mcp` now does this. Payload's `cloudflare-access-gateway` strategy checks the gateway proof before it trusts a forwarded JWT. The connector hands the model the tool's text as it comes, and writes go through Payload's REST API as drafts rather than through the plugin's update tool, which stays off. Checked locally against the Payload Worker with stand-in Access keys: a wrong proof signs nobody in, an approved change lands as a draft while the published post is unchanged, and a collection without drafts is refused.

Since then the gateway writes rich text as Markdown and creates new drafts. Payload does the conversion itself, through read-only custom tools (`apps/payload/src/mcp-tools.ts`) built on `convertMarkdownToLexical` and `convertLexicalToMarkdown` from `@payloadcms/richtext-lexical`, which run in workerd. Checked the same way: headings, bold, links and lists round-trip, a new post saved as a draft is not public, and a collection without drafts is refused.
