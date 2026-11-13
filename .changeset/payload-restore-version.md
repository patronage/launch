---
"@patronage/mcp-payload": minor
---

`payload.apply` takes `restore_version` and `restore_global_version` operations: bring back an earlier version of a document or a global through Payload's own restore route. The whole version comes back as a new draft, and what is published stays as it is unless the operation sets `publish: true`, which publishes the restored draft in a second write. Both require `expected_updated_at`. The approval names the version and shows each field the restore changes. A document another editor has open is refused: Payload restores over an editor's lock, so the gateway asks the site's new `getDocumentLock` tool first, and a site without it gets no document restores. A version of a file cannot be restored.
