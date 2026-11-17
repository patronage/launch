---
"@patronage/mcp-payload": patch
"@patronage/mcp-wordpress": patch
---

The connector's instructions to the model no longer say that every write pauses for human approval. Whether a write is held is now the deployment's setting (`APPROVAL_REQUIRED` in `@patronage/mcp-core`), and the `execute` tool description says which applies.
