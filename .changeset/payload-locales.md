---
"@patronage/mcp-payload": minor
---

Write one locale of a Payload site that has several. `update_draft`, `create_draft`, `patch_rows`, `update_global`, `upload_media`, `replace_media_file` and `unpublish` take a `locale`; without one they write the default locale, as before. The approval marks each field for that locale alone or for every locale, and a locale the site does not have is refused. Where Payload keeps a status for each locale, `publish: true` publishes the operation's locale, `publish_all_locales: true` publishes them all, and `unpublish` with a `locale` takes down that one alone. Needs a `getEditingInfo` that lists `localizedFields`.
