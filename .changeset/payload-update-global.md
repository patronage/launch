---
"@patronage/mcp-payload": minor
---

`payload.apply` takes an `update_global` operation: change a global's top-level fields, and the rows of its array and blocks fields with the same changes as `patch_rows`. It requires `expected_updated_at`. A global that keeps drafts is saved as a draft unless the operation sets `publish: true`; a global without drafts is live as soon as it is saved, so the operation is refused without `publish: true` and its approval carries a warning. Markdown is not converted for a global yet.
