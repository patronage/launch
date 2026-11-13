# MCP gateway

An editor's agent reads and changes Payload content through the MCP gateway (`apps/mcp`). Reads run as the signed-in editor. Every write pauses until a person approves it on the approval page, then runs as that person and is saved as a draft.

Locally the three parts run on one machine: the gateway on `vite dev`, the Payload app on local D1 and R2, and a stand-in for the Cloudflare Access team domain that signs a JWT for a synthetic editor. Nothing hosted is involved, and the code-mode sandbox (a Dynamic Worker) runs in local workerd.

## Sub-features

- `sign-in`: a request signed by the stand-in gets in; one with no sign-in is refused with 403. Payload's own OAuth sign-in for MCP clients answers 404.
- `read`: `execute` runs a script that reads through `payload.call`.
- `approve`: `payload.apply` pauses, the approval page shows the change before and after, and Approve writes it.
- `stale`: a request built on an old `updatedAt` gets an approval page with the reason and no Approve button.
- `draft-only`: the approved change is the newest draft; the published document is unchanged.
- `rows`: a `patch_rows` operation changes one row of a page's sections; every other row is as it was, and an approval drawn before someone else's save is refused.
- `global`: an `update_global` operation changes the site settings, which keep no drafts: it is refused without `publish: true`, and while a second editor holds Payload's lock on it, and its approval warns that the change is live at once.
- `unpublish`: an `unpublish` operation takes a published post off the public site and keeps its newer draft; the approval warns that the page at its path goes away, and a post that is already a draft is refused.
- `upload`: `payload.stageUpload` keeps a picture in the gateway, the approval page shows its thumbnail, and Approve saves it through Payload's upload route to local R2.
- `replace`: the approval page shows the old file beside the new one with a warning, and Approve replaces it.
- `refused-file`: an SVG, and a URL the collection does not allow, are refused when staged, before any approval.

## How to get to it (user POV)

- An MCP client (Claude, Codex, Cursor) connected to the gateway's `/mcp`. Locally the drive is the client.
- The approval link the gateway returns: `/mcp/approvals/<run>`.

## Driving it with verify.ts

Preconditions: the one-time setup in SKILL.md (the shared proof secret in both apps' `.dev.vars`), Payload seeded, and `launch mcp` ending with `Doctor: PASS`.

- **Draft write, end to end**: `drive mcp payload-draft`. It signs in as the first local admin, lists the tools, reads the newest draft of the first published post, sends a retitle with a stale `expected_updated_at` and checks its approval page offers no Approve, sends the real one, approves it in a browser, reads the receipt with `get_run`, and reads the post back twice: the newest draft holds the new title and the public API still returns the old one. Evidence: `transcript.md`, the three approval-page screenshots, `run.json` (the receipt) and the gateway's `server-log.txt` with each request's wide event.
- **Change rows of a page**: `drive mcp payload-rows`. On the seeded home page it retitles one card of a card grid with a `patch_rows` operation and leaves that approval page open, approves a second request that inserts a card, then clicks Approve on the first page and checks it is refused (`modified_since_preflight`) with nothing written. It then retitles the card, removes the inserted card and resends one section's Markdown unchanged in one request, approves it, and checks that the draft holds the new title, every other row is byte for byte as first read, the unchanged Markdown is not reported as a change, and the published page is as it was. Evidence: `transcript.md`, five approval-page screenshots (look for the row label, such as "Layout › Card grid (row 3) › Cards › row 2 › Title"), `run.json` and `server-log.txt`.
- **Change a global**: `drive mcp payload-global`. It asks to change the site's tagline without `publish: true` and with a stale `expected_updated_at`, and checks both pages give the reason and no Approve button. It adds a second editor and Payload's lock on the site settings for them, as the admin keeps while a form is open, checks the change is refused and their lock is still there, and removes both. It then approves the change with `publish: true`, checks the warning on the approval page, the receipt (`tagline` changed, with a version) and that Payload's public API serves the new tagline with the site name untouched. Last it puts the tagline back with a second write built on the first receipt's `updated_at`, so the site ends as it began. Evidence: `transcript.md`, seven approval-page screenshots (look for the "Heads up" warning), `change-run.json`, `restore-run.json` and `server-log.txt`.
- **Unpublish a post**: `drive mcp payload-unpublish`. On the first published post with no newer draft it saves another title and slug as a draft, then checks that an unpublish built on the read from before that draft is refused. It approves the unpublish built on the draft's receipt, checks the warning on the approval page (the post's published `/news/…` path, not the draft's, and that links to it will 404 unless a redirect covers them), the receipt (`_status` changed, with a version), that Payload's public API and the page both answer 404, and that the draft title was kept. A second unpublish is refused as `already_draft`. Last it publishes the post again with its first title and slug, so the site ends as it began, and checks the page answers 200. Evidence: `transcript.md`, the approval-page screenshots (look for the "Heads up" warning on the unpublish), `draft-run.json`, `unpublish-run.json`, `republish-run.json` and `server-log.txt`.
- **Upload and replace a file**: `drive mcp payload-upload`. It stages an SVG declared as a PNG and a URL the media collection does not allow, and checks both are refused. It then draws a small PNG of its own, stages it as base64, approves the `upload_media` in a browser, and checks that Payload's public API serves the same bytes that were approved. Last it stages a second picture, approves a `replace_media_file` for the same document, and checks the new bytes are served and the alt text is kept. Evidence: `transcript.md`, four approval-page screenshots (look for the thumbnails: one on the upload, two on the replacement), `run.json` and `server-log.txt`.
- **Another operation by hand**: sign a JWT the way the drive does (`signIn` in `scripts/drive.ts`) and send `tools/call` for `execute` to `http://localhost:8787/mcp` with it in `Cf-Access-Jwt-Assertion`. Open the approval link in a browser that sends the same header.

## Gotchas

- `launch mcp` rebuilds Payload with the stand-in as its Access team domain. A Payload server started by a plain `launch payload` doesn't trust the stand-in, so launch refuses to reuse it: run `cleanup payload` first.
- A restarted stand-in has a new key. Servers that cached the old one fetch the new one on the next request, at most every 30 seconds.
- The drive leaves its draft in place. Every run edits the same post (the first published one by title) and replaces the last run's marker in the draft's title.
- `payload-upload` adds one media document per run and leaves it in place.
- Thumbnails come from the Images binding, which local workerd provides. A page with no thumbnail means the binding is missing from `apps/mcp/cloudflare.config.ts` or the file is not a picture.
- The inline approval card that MCP hosts render is not covered here: it needs a real host. The approval page it mirrors is.
