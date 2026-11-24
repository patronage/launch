# @patronage/mcp-wordpress

## 0.3.1

### Patch Changes

- 19a9b64: The connector's instructions to the model no longer say that every write pauses for human approval. Whether a write is held is now the deployment's setting (`APPROVAL_REQUIRED` in `@patronage/mcp-core`), and the `execute` tool description says which applies.
- fe5c197: Updated dependencies to their latest minor and patch releases.
- 6c071cd: `wp.apply` can set media alt text with `fields.alt_text` on `rest_base: "media"`. The approval preview shows the whole value, apply refuses to overwrite alt text that changed after the preview, and the saved text must match the request exactly.
- Updated dependencies [56cd93c]
- Updated dependencies [809b365]
- Updated dependencies [19a9b64]
- Updated dependencies [145051c]
- Updated dependencies [d0b330b]
- Updated dependencies [4a66108]
- Updated dependencies [fe5c197]
- Updated dependencies [cacc1bb]
- Updated dependencies [19a9b64]
  - @patronage/mcp-core@0.3.0

## 0.3.0

### Minor Changes

- Uses `@patronage/mcp-core` 0.2.0: approved writes get 5 minutes, run two operations at a time and report progress. The approval card polls the new app-only `progress_write` tool.
- Its requests are tagged `connector: "wp"` on the wide event's `upstream` field.
- The connector's instructions tell the model to do every read before `wp.apply`, since reads after an approved write are refused.
- The connector tool contract for `wp.apply` matches the optional execution context.

## 0.2.0

### Minor Changes

- `update_post` takes a `meta` object of registered REST meta, previewed and read back as `meta.<key>`.
- A new `upsert_redirect` operation creates or updates one plain-URL Redirection rule through Redirection's REST API, with the same preview, conflict check and readback as a post update. New redirects go into Redirection's default group.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): WPGraphQL and REST reads, and post updates through the approval step.
