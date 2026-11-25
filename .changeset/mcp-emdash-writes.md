---
"@patronage/mcp-emdash": minor
---

Add `emdash.apply` with `update_draft`, `create_draft` and `publish` operations. Each write is built on the entry's `_rev`, held for approval where the gateway requires it, and read back for its receipt. `describe_site` and the write preview now read collections from EmDash's admin manifest, so authors as well as editors can use the connector.
