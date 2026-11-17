---
"@patronage/mcp-payload": minor
---

`payload.apply` takes a `patch_rows` operation: change, insert, remove or move single rows of an array or blocks field by row id (`layout[id=…].cards[id=…].title`), without resending the field. It requires `expected_updated_at`, sends only the top-level fields its changes touch, labels each change in the approval by where its row sits, and reports the ids of inserted rows in the receipt's `details.inserted_row_ids`. Rich text inside a row is written as Markdown with `set_markdown`, which needs Payload's `markdownToRichText` and `richTextToMarkdown` tools to accept a `path`.
