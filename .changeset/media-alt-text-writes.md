---
"@patronage/mcp-wordpress": patch
---

`wp.apply` can set media alt text with `fields.alt_text` on `rest_base: "media"`. The approval preview shows the whole value, apply refuses to overwrite alt text that changed after the preview, and the saved text must match the request exactly.
