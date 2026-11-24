# @patronage/mcp-payload

## 0.3.0

### Minor Changes

- d0b330b: The connector reads the wider `getEditingInfo` that `apps/payload` now serves: array and blocks fields with what their rows hold, relationship and upload fields, upload limits, trash, autosave, globals and locales, all passed on to `describe_site`. A Payload that still serves the first version keeps working. Approval previews name related documents and files by title instead of showing ids, and link to the front end's draft preview where Payload has the optional `getPreviewUrl` tool. Receipts carry `updated_at`, `version_id`, a new document's `details.id` and `details.preview_url`, and a document another editor has open is reported as `locked` with status `conflict`.

  Breaking for code that calls the package directly: `readEditingInfo` now returns `{ collections, globals, localization }` instead of the collections array.

- cba5695: Write one locale of a Payload site that has several. `update_draft`, `create_draft`, `patch_rows`, `update_global`, `upload_media`, `replace_media_file` and `unpublish` take a `locale`; without one they write the default locale, as before. The approval marks each field for that locale alone or for every locale, and a locale the site does not have is refused. Where Payload keeps a status for each locale, `publish: true` publishes the operation's locale, `publish_all_locales: true` publishes them all, and `unpublish` with a `locale` takes down that one alone. Needs a `getEditingInfo` that lists `localizedFields`.
- 1a82322: `payload.apply` takes a `patch_rows` operation: change, insert, remove or move single rows of an array or blocks field by row id (`layout[id=…].cards[id=…].title`), without resending the field. It requires `expected_updated_at`, sends only the top-level fields its changes touch, labels each change in the approval by where its row sits, and reports the ids of inserted rows in the receipt's `details.inserted_row_ids`. Rich text inside a row is written as Markdown with `set_markdown`, which needs Payload's `markdownToRichText` and `richTextToMarkdown` tools to accept a `path`.
- f942e68: `payload.apply` takes `restore_version` and `restore_global_version` operations: bring back an earlier version of a document or a global through Payload's own restore route. The whole version comes back as a new draft, and what is published stays as it is unless the operation sets `publish: true`, which publishes the restored draft in a second write. Both require `expected_updated_at`. The approval names the version and shows each field the restore changes. A document another editor has open is refused: Payload restores over an editor's lock, so the gateway asks the site's new `getDocumentLock` tool first, and a site without it gets no document restores. A version of a file cannot be restored.
- 5ff8def: `payload.apply` takes `trash` and `restore_from_trash` operations: move a document to the trash and take it back out, on collections that keep a trash. The gateway never deletes anything for good; both are the saves of `deletedAt` the admin itself sends, so Payload checks the editor's permissions and another editor's lock. Both require `expected_updated_at`. The approval of a trash warns that a public page goes away as soon as it is approved and lists documents that point at the document through a relationship field outside any row. A restore brings the document back as a draft unless the operation sets `publish: true`. Upload collections and collections without a trash are refused.
- 0a6ad6e: `payload.apply` takes an `unpublish` operation: take a published document off the public site and keep its content as a draft, the way the admin's Unpublish button does. It requires `expected_updated_at`, is refused for a document that is not published, and its approval warns that the public page goes away as soon as it is approved, naming the page's path where the site's `getPreviewUrl` gives it.
- 5081b10: `payload.apply` takes an `update_global` operation: change a global's top-level fields, and the rows of its array and blocks fields with the same changes as `patch_rows`. It requires `expected_updated_at`. A global that keeps drafts is saved as a draft unless the operation sets `publish: true`; a global without drafts is live as soon as it is saved, so the operation is refused without `publish: true` and its approval carries a warning. Markdown is not converted for a global yet. A global another editor has open in the admin is refused: Payload saves a global over an editor's lock, so the gateway reads `locked` from the site's `getEditingInfo` first, and a site that does not report it gets no global writes. Read a global for an edit with the site's `findGlobalDraft` tool, which `payload.call` now allows.
- cacc1bb: Upload a file to a Payload upload collection, or replace one. `payload.stageUpload` keeps a file in the gateway, from a URL on the collection's `upload.pasteURL.allowList` or from a small base64 string, checks its real type and refuses SVG. `payload.apply` takes two new operations, `upload_media` and `replace_media_file`, whose approval shows the file's thumbnail, type, size and hash, and which save through Payload's own upload route as the approver. `PayloadEnv` gains an optional `IMAGES` binding for thumbnails, and `DraftApplyInput.operations` is now `PayloadOperation[]`, which includes the upload kinds. A receipt's `version_id` is now found for collections without drafts too.

### Patch Changes

- 19a9b64: The connector's instructions to the model no longer say that every write pauses for human approval. Whether a write is held is now the deployment's setting (`APPROVAL_REQUIRED` in `@patronage/mcp-core`), and the `execute` tool description says which applies.
- fe5c197: Updated dependencies to their latest minor and patch releases.
- Updated dependencies [56cd93c]
- Updated dependencies [809b365]
- Updated dependencies [19a9b64]
- Updated dependencies [145051c]
- Updated dependencies [d0b330b]
- Updated dependencies [4a66108]
- Updated dependencies [fe5c197]
- Updated dependencies [cacc1bb]
- Updated dependencies [19a9b64]
  - @patronage/mcp-core@0.3.0

## 0.2.0

### Minor Changes

- Uses `@patronage/mcp-core` 0.2.0, so a site installs both at the same version. 0.1.0 depends on mcp-core 0.1.0.
- The connector's instructions tell the model to do every read before `payload.apply`, since reads after an approved write are refused.
- `payload.apply` reports progress as each operation settles, so an interrupted write no longer marks drafts it already created as unconfirmed.
- Its requests are tagged `connector: "payload"` on the wide event's `upstream` field, and its errors name Payload.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): Payload's own MCP read tools, and `update_draft` and `create_draft` writes through the approval step. An operation can set `publish: true`, which the approval card shows as a `_status` change, and a requested publish that Payload saved as a draft fails.
