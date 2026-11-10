# @patronage/mcp-wordpress

## 0.3.0

### Minor Changes

- Uses `@patronage/mcp-core` 0.2.0: approved writes get 5 minutes, run two operations at a time and report progress. The approval card polls the new app-only `progress_write` tool.
- Its requests are tagged `connector: "wp"` on the wide event's `upstream` field.
- The connector's instructions tell the model to do every read before `wp.apply`, since reads after an approved write are refused.

## 0.2.0

### Minor Changes

- `update_post` takes a `meta` object of registered REST meta, previewed and read back as `meta.<key>`.
- A new `upsert_redirect` operation creates or updates one plain-URL Redirection rule through Redirection's REST API, with the same preview, conflict check and readback as a post update. New redirects go into Redirection's default group.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): WPGraphQL and REST reads, and post updates through the approval step.
