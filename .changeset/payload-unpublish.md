---
"@patronage/mcp-payload": minor
---

`payload.apply` takes an `unpublish` operation: take a published document off the public site and keep its content as a draft, the way the admin's Unpublish button does. It requires `expected_updated_at`, is refused for a document that is not published, and its approval warns that the public page goes away as soon as it is approved, naming the page's path where the site's `getPreviewUrl` gives it.
