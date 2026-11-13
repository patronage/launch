---
"@patronage/mcp-payload": minor
---

The connector reads the wider `getEditingInfo` that `apps/payload` now serves: array and blocks fields with what their rows hold, relationship and upload fields, upload limits, trash, autosave, globals and locales, all passed on to `describe_site`. A Payload that still serves the first version keeps working. Approval previews name related documents and files by title instead of showing ids, and link to the front end's draft preview where Payload has the optional `getPreviewUrl` tool. Receipts carry `updated_at`, `version_id`, a new document's `details.id` and `details.preview_url`, and a document another editor has open is reported as `locked` with status `conflict`.

Breaking for code that calls the package directly: `readEditingInfo` now returns `{ collections, globals, localization }` instead of the collections array.
