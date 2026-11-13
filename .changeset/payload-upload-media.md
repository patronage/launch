---
"@patronage/mcp-payload": minor
---

Upload a file to a Payload upload collection, or replace one. `payload.stageUpload` keeps a file in the gateway, from a URL on the collection's `upload.pasteURL.allowList` or from a small base64 string, checks its real type and refuses SVG. `payload.apply` takes two new operations, `upload_media` and `replace_media_file`, whose approval shows the file's thumbnail, type, size and hash, and which save through Payload's own upload route as the approver. `PayloadEnv` gains an optional `IMAGES` binding for thumbnails, and `DraftApplyInput.operations` is now `PayloadOperation[]`, which includes the upload kinds. A receipt's `version_id` is now found for collections without drafts too.
