# @patronage/mcp-core

## 0.2.0

### Minor Changes

- The pass that an approval resumes gets 5 minutes; ordinary runs keep 60 seconds. Both can be overridden on `BaseGatewayRuntime`.
- Approval waits for the write itself, not only the sandbox pass, so a run is reported from the write's own receipt. `get_run` reports the write apart from the script, and rebuilds a partial receipt, with `unconfirmed` operations, when a write stops before returning one.
- A batch runs two operations at a time (`APPLY_CONCURRENCY`), previews too, and receipts keep index order. Each settled operation is recorded as progress, and the approval page streams one line per operation.
- When an approval resumes a script, every tool but the approved write is refused, and the write must match the recorded arguments as JSON. Reads later in the script no longer run with the approver's access.

- A run left running by a gateway instance that is gone is reported as an error with an interrupted receipt, instead of running until it expires. Apply progress belongs to the apply call that wrote it, so a later write never shows an earlier write's progress.
- The wp connector is left out when `WORDPRESS_API_URL` is unset, browser `Origin` headers are checked against the endpoint's hostnames, and logs carry the package version and the execution id of finished runs.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): the MCP gateway Worker, with Access sign-in, code mode over CMS connectors, and a human approval step before every write. The approval card's script is bundled into the package.
