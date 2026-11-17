---
"@patronage/mcp-payload": minor
---

`payload.apply` takes `trash` and `restore_from_trash` operations: move a document to the trash and take it back out, on collections that keep a trash. The gateway never deletes anything for good; both are the saves of `deletedAt` the admin itself sends, so Payload checks the editor's permissions and another editor's lock. Both require `expected_updated_at`. The approval of a trash warns that a public page goes away as soon as it is approved and lists documents that point at the document through a relationship field outside any row. A restore brings the document back as a draft unless the operation sets `publish: true`. Upload collections and collections without a trash are refused.
