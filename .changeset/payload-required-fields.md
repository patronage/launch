---
"@patronage/mcp-payload": patch
---

`create_draft` is refused at the preview when it leaves out a field the collection requires, where Payload would refuse it (a publish, a collection without drafts, or one that validates drafts), so nobody is asked to approve a write that can't land. Reads `requiredFields` and `validatesDrafts` from `getEditingInfo`; a site whose `getEditingInfo` doesn't list them is not checked.
