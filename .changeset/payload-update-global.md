---
"@patronage/mcp-payload": minor
---

`payload.apply` takes an `update_global` operation: change a global's top-level fields, and the rows of its array and blocks fields with the same changes as `patch_rows`. It requires `expected_updated_at`. A global that keeps drafts is saved as a draft unless the operation sets `publish: true`; a global without drafts is live as soon as it is saved, so the operation is refused without `publish: true` and its approval carries a warning. Markdown is not converted for a global yet. A global another editor has open in the admin is refused: Payload saves a global over an editor's lock, so the gateway reads `locked` from the site's `getEditingInfo` first, and a site that does not report it gets no global writes. Read a global for an edit with the site's `findGlobalDraft` tool, which `payload.call` now allows.
