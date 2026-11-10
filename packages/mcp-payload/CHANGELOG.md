# @patronage/mcp-payload

## 0.2.0

### Minor Changes

- Uses `@patronage/mcp-core` 0.2.0, so a site installs both at the same version. 0.1.0 depends on mcp-core 0.1.0.
- The connector's instructions tell the model to do every read before `payload.apply`, since reads after an approved write are refused.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): Payload's own MCP read tools, and `update_draft` and `create_draft` writes through the approval step. An operation can set `publish: true`, which the approval card shows as a `_status` change, and a requested publish that Payload saved as a draft fails.
