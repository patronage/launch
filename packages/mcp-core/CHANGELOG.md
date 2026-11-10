# @patronage/mcp-core

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
