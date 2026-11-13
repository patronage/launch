# MCP gateway

An editor's agent reads and changes Payload content through the MCP gateway (`apps/mcp`). Reads run as the signed-in editor. Every write pauses until a person approves it on the approval page, then runs as that person and is saved as a draft.

Locally the three parts run on one machine: the gateway on `vite dev`, the Payload app on local D1 and R2, and a stand-in for the Cloudflare Access team domain that signs a JWT for a synthetic editor. Nothing hosted is involved, and the code-mode sandbox (a Dynamic Worker) runs in local workerd.

## Sub-features

- `sign-in`: a request signed by the stand-in gets in; one with no sign-in is refused with 403. Payload's own OAuth sign-in for MCP clients answers 404.
- `read`: `execute` runs a script that reads through `payload.call`.
- `approve`: `payload.apply` pauses, the approval page shows the change before and after, and Approve writes it.
- `stale`: a request built on an old `updatedAt` gets an approval page with the reason and no Approve button.
- `draft-only`: the approved change is the newest draft; the published document is unchanged.

## How to get to it (user POV)

- An MCP client (Claude, Codex, Cursor) connected to the gateway's `/mcp`. Locally the drive is the client.
- The approval link the gateway returns: `/mcp/approvals/<run>`.

## Driving it with verify.ts

Preconditions: the one-time setup in SKILL.md (the shared proof secret in both apps' `.dev.vars`), Payload seeded, and `launch mcp` ending with `Doctor: PASS`.

- **Draft write, end to end**: `drive mcp payload-draft`. It signs in as the first local admin, lists the tools, reads the newest draft of the first published post, sends a retitle with a stale `expected_updated_at` and checks its approval page offers no Approve, sends the real one, approves it in a browser, reads the receipt with `get_run`, and reads the post back twice: the newest draft holds the new title and the public API still returns the old one. Evidence: `transcript.md`, the three approval-page screenshots, `run.json` (the receipt) and the gateway's `server-log.txt` with each request's wide event.
- **Another operation by hand**: sign a JWT the way the drive does (`signIn` in `scripts/drive.ts`) and send `tools/call` for `execute` to `http://localhost:8787/mcp` with it in `Cf-Access-Jwt-Assertion`. Open the approval link in a browser that sends the same header.

## Gotchas

- `launch mcp` rebuilds Payload with the stand-in as its Access team domain. A Payload server started by a plain `launch payload` doesn't trust the stand-in, so launch refuses to reuse it: run `cleanup payload` first.
- A restarted stand-in has a new key. Servers that cached the old one fetch the new one on the next request, at most every 30 seconds.
- The drive leaves its draft in place. Every run edits the same post (the first published one by title) and replaces the last run's marker in the draft's title.
- The inline approval card that MCP hosts render is not covered here: it needs a real host. The approval page it mirrors is.
