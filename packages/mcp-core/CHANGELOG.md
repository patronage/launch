# @patronage/mcp-core

## 0.3.0

### Minor Changes

- 19a9b64: **Breaking:** writes are no longer held for approval unless the deployment asks. `execute` now applies each write as soon as the model's code calls `apply`, as the signed-in person, and returns the script's result with a receipt for each write in `receipts`. Set `APPROVAL_REQUIRED` to `"true"` to keep the approval card and page; a site that relies on approval must set it before upgrading. Any value other than unset, empty or `"false"` asks for approval.

  Without approval, `execute` is annotated as a tool that writes, its description tells the model there is no approval step, no card, card tools or approval link are offered, a write that cannot be previewed is rejected, and one run may make at most 10 writes. The wide event records these writes with `approval.outcome: "not_required"`. `APPROVAL_CSRF_SECRET` is needed only where approval is required.

- 145051c: Approval previews can show a thumbnail beside a media change (`beforeImage` and `afterImage` on a field snapshot), a readable label for a row path, and a warning on an operation that changes what the public sees at once. Receipts can carry `version_id`, `updated_at` and bounded `details`. The runtime store can stage a file for a later `apply` (`stageBlob`, `readBlob`, `readBlobMeta`), and a connector's `preflight` receives the run's id and store. The approval page's Content-Security-Policy now allows `data:` images, and the approval card moves to `ui://patronage/cms-approval-v5.html`; the earlier URIs keep working.
- d0b330b: An operation's approval preview can carry `previewUrl`, a link to the target as the front end shows it now. The approval page offers it beside the edit link, over HTTPS only.
- cacc1bb: Helpers for a connector that takes files: `sniffFileType`, `extensionsFor` and `typeAllowed` read and check a file's type from its bytes, `describeImage` measures a picture and makes the thumbnail the approval surfaces draw (with the optional `IMAGES` binding on `GatewayEnv`), `upstreamFetchBytes` reads a file from the CMS as the editor, and `readBoundedBody` and `sha256Hex` are exported.

### Patch Changes

- 56cd93c: Add an agent feedback channel. Agents file reports with `submit_feedback` and read the answers with `get_feedback`. Maintainers read and answer them over `/mcp/feedback`, which is off unless `FEEDBACK_MAINTAINER_TOKEN` is set.
- 809b365: Move the approval card's link and error-reason helpers into their own module so they can be tested on their own. No change in behaviour.
- 4a66108: `delay` returns at once when its signal is already aborted. An approval that settled before the first progress poll used to wait out the full 1.5 s poll interval before its result was streamed.
- fe5c197: Updated dependencies to their latest minor and patch releases.
- 19a9b64: Offer the approval card to clients that state MCP Apps support only in `initialize`. The gateway keeps no session, so it used to read every later request from such a client as stating nothing, and listed no card, no card resource and no card tools. It now answers `initialize` with an `Mcp-Session-Id` that carries what the client stated, and reads it back on the requests that follow. The per-request capabilities envelope still decides when a request has one.
- Updated dependencies [fe5c197]
  - @patronage/access@0.2.1

## 0.2.0

### Minor Changes

- The pass that an approval resumes gets 5 minutes; ordinary runs keep 60 seconds. Both can be overridden on `BaseGatewayRuntime`.
- Approval waits for the write itself, not only the sandbox pass, so a run is reported from the write's own receipt. `get_run` reports the write apart from the script, and rebuilds a partial receipt, with `unconfirmed` operations, when a write stops before returning one.
- A batch runs two operations at a time (`APPLY_CONCURRENCY`), previews too, and receipts keep index order. Each settled operation is recorded as progress, and the approval page streams one line per operation.
- When an approval resumes a script, every tool but the approved write is refused, and the write must match the recorded arguments as JSON. Reads later in the script no longer run with the approver's access.
- A run left running by a gateway instance that is gone is reported as an error with an interrupted receipt, instead of running until it expires. Apply progress belongs to the apply call that wrote it, so a later write never shows an earlier write's progress.
- The wp connector is left out when `WORDPRESS_API_URL` is unset, browser `Origin` headers are checked against the endpoint's hostnames, and logs carry the package version and the execution id of finished runs.
- Every paused `execute` result names its approval URL, card or not, and the card state carries it too. A card whose call fails shows the reason and a button that opens the approval page. The card's own tools are served on a `tools/call` that states no client capabilities.
- The approval card's tools are renamed `preview_write`, `progress_write` and `decide_write`, and the card resource moves to `ui://patronage/cms-approval-v4.html`. A card a host cached from 0.1.0 calls the old names and falls back to the approval link.
- Wide event changes (update saved queries): `wordpress` is now `upstream`, with a `connector` on each request; `approval.wordpressActor` is `approval.upstreamActor`; the audit target type is `cms`; `service` is the Worker's name from `WORKER_NAME`. New fields: `mcp.method`, `mcp.methods`, `mcp.resource` and `run.approval`. Access refusals log `mcp.outcome` as `challenged` or `denied`, and paths outside `/mcp` get a 404 with no `mcp` fields.
- `UpstreamClient` takes an optional `connector` name.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): the MCP gateway Worker, with Access sign-in, code mode over CMS connectors, and a human approval step before every write. The approval card's script is bundled into the package.
