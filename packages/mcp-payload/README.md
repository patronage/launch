# @patronage/mcp-payload

The Payload connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `payload`:

- `payload.tools()` and `payload.call({ tool, arguments })` run Payload's own read tools at `/api/mcp` as the signed-in editor. Only read tools are allowed.
- `payload.apply({ intent, operations })` stages `update_draft` and `create_draft` operations for approval. Approved changes are saved as drafts unless an operation sets `publish: true`, which the approval card shows as a `_status` change to `published`.
- Rich text fields can be written as Markdown, converted with the field's own editor features.
- A `patch_rows` operation changes, inserts, removes or moves single rows of an array or blocks field by row id, without resending the field.
- An `update_global` operation changes a global's top-level fields and the rows of its array and blocks fields.
- An `unpublish` operation takes a published document off the public site and keeps its content as a draft.
- `restore_version` and `restore_global_version` operations bring back an earlier version of a document or a global, as a new draft unless the operation publishes.
- `trash` and `restore_from_trash` operations move a document to the trash and take it back out. Nothing is deleted for good.
- On a site with locales, an operation can name the `locale` it writes, and publishing and unpublishing are by locale.
- `payload.stageUpload({ collection, source })` keeps a file in the gateway for a later `upload_media` or `replace_media_file` operation in the same script. It writes nothing to Payload.

## Rows

An array or blocks field (a page's sections, a card grid's cards, a hero's links) is a list of rows, each with an `id` Payload gave it. `update_draft` can only replace such a field whole. `patch_rows` changes the rows it names and leaves the rest as they were read:

```js
await payload.apply({
  intent: "Retitle the second card and add a link to the hero",
  operations: [
    {
      kind: "patch_rows",
      collection: "pages",
      id: 1,
      expected_updated_at: page.updatedAt,
      changes: [
        {
          op: "set",
          path: "layout[id=6650a1f2].cards[id=b7c1].title",
          value: "Tool share",
        },
        {
          op: "set_markdown",
          path: "layout[id=6650a1f0].body",
          markdown: "We turn empty lots into **shared gardens**.",
        },
        {
          op: "insert",
          field: "hero.links",
          after_id: null,
          row: { link: { type: "custom", url: "/join", label: "Join" } },
        },
        { op: "remove", field: "layout", row_id: "6650a1f9" },
        {
          op: "move",
          field: "layout",
          row_id: "6650a1f4",
          after_id: "6650a1f2",
        },
      ],
    },
  ],
});
```

- **Paths.** Field names join with a dot, and `[id=<row id>]` after an array or blocks field picks one row: `layout[id=6650a1f2].cards[id=b7c1].title`. A `set` or `set_markdown` path picks a row and ends at one of its fields; the `field` of an `insert`, `remove` or `move` ends at the array or blocks field. A path is only taken apart, never evaluated. It is at most 400 characters and four rows deep (as deep as `getEditingInfo` describes rows), and cannot name `id`, `blockType`, `createdAt` or `updatedAt`. Row ids and `updatedAt` come from a `draft: true`, `depth: 0` read; `describe_site` lists each collection's `rowFields`.
- **Changes** are 1 to 50 and apply in order, to a copy of the document as it was read. `set` takes the value as Payload stores it and is refused on a rich text field, which takes `set_markdown` (converted with that nested field's own editor, and refused when the stored value holds nodes Markdown cannot carry). `insert` puts a row first (`after_id: null`) or right after another row; a blocks row needs a `blockType` the field takes, and a new row carries no `id`. `move` works the same way. Refused: two changes to the same field of a row, two removes or moves of one row, a change inside a row the same operation removes, a `set` anywhere inside a rich text field's stored value, and more than 12 inserts in one operation (as many as the receipt can name).
- **`expected_updated_at` is required.** The request is refused before approval when the document has changed since it was read, and again at approval when it has changed since the preview was drawn (`modified_since_preflight`), so a row someone edited in the admin in between is never overwritten.
- **What is sent.** After approval the gateway reads the draft again, applies the changes, and sends only the top-level fields they touch in one `PATCH ?draft=true` (or published, with `publish: true`). Every row the changes did not name goes back exactly as it was read.
- **The approval** shows one line per change, labelled by where the row sits (`Layout › Card grid (row 3) › Cards › row 2 › Title`), with before and after: a new row's fields under `(new row)`, a removed row's fields against `(removed)`, and a move as its old and new position. Rows that do not change are not shown.
- **The receipt** lists each changed path in `changed_paths`, and gives the ids Payload made for inserted rows in `details.inserted_row_ids`, comma-separated in the order they were inserted. An id is never cut short: if the ids are too long to all fit, the receipt lists the ones that do and gives the number of new rows in `details.inserted_row_count`.

## Globals

A global is the one document of its own kind that holds site settings, a footer or the like. `update_global` changes it:

```js
await payload.apply({
  intent: "Change the site's tagline",
  operations: [
    {
      kind: "update_global",
      global: "site-settings",
      expected_updated_at: settings.updatedAt,
      fields: { tagline: "Grow food, block by block" },
      publish: true,
    },
  ],
});
```

- `fields` holds top-level values as Payload stores them, and `changes` takes the row changes of [`patch_rows`](#rows) for the global's array and blocks fields. A field cannot be in both. Markdown is not converted for a global yet: a rich text field is set as Lexical JSON in `fields`, and `set_markdown` is refused.
- **Drafts decide what `publish` means.** A global that keeps drafts is saved as a draft unless the operation sets `publish: true`, which the approval shows as a `_status` row. A global without drafts is live the moment it is saved, so the operation is refused (`publish_required`) unless it says `publish: true`, and its approval carries the warning "This global has no drafts: the change is live as soon as you approve." `describe_site` lists each global with `drafts` and `canUpdate`.
- **`expected_updated_at` is required**, read with `findGlobalDraft`, which gives the global's newest version as the admin opens it. Payload's own `findGlobal` reads the published global, whose `updatedAt` is refused as stale while a newer draft exists. The request is refused when the global has changed since it was read, and again at approval when it has changed since the preview.
- **A global another editor has open is left alone** (`locked`). Payload's REST endpoint for a global saves over an editor's lock and removes it, where the one for a document answers 423. So the gateway reads the lock from `getEditingInfo`, which reports `locked` for each global, when the approval is drawn and again just before it saves, and writes nothing while another editor's lock holds. A lock taken in the moment between that last check and the save is not seen. A site whose `getEditingInfo` does not report `locked` gets no global writes (`lock_unknown`).
- After approval the gateway sends only the fields whose value differs, in one `POST /api/globals/{slug}` as the approver, and reads the global back. Nothing is sent, and no version is made, when every field is already as asked. The receipt's target is `globals/{slug}`; it carries `updated_at`, the `version_id` of the version the write made and, for inserted rows, `details.inserted_row_ids`.

## Unpublishing

`unpublish` takes a published document off the public site and keeps its content as a draft:

```js
await payload.apply({
  intent: "Take the cleanup day post down",
  operations: [
    {
      kind: "unpublish",
      collection: "posts",
      id: 4,
      expected_updated_at: post.updatedAt,
    },
  ],
});
```

- It is the request the admin's own Unpublish button sends: `PATCH /api/{collection}/{id}?unpublishAllLocales=true` with `_status: "draft"`, as the approver. It takes every locale of the document down; with a `locale` it takes down that one alone (see [Locales](#locales)). Payload carries the newest draft's content over to the document, marks the newest version a draft in place rather than adding one, and stops serving the document to anonymous reads. No other field changes.
- **The approval warns that the public page goes away at once**, and names it where it can: "The public page at /news/fall-cleanup-day goes away as soon as you approve. Links to it will 404 unless a redirect covers them." The path comes from `getPreviewUrl`, which now answers with the document's public `path` beside its preview `url`: the address of its published version, which a newer draft with another slug does not change. The gateway does not say whether a redirect would catch those links, and never makes one: which redirect a front end follows, and whether its destination can be reached, are that front end's rules.
- **`expected_updated_at` is required**, read with `draft: true`. The request is refused when the document has changed since it was read, and again at approval when it has changed since the preview.
- A document that is not published is refused (`already_draft`), as is a collection without drafts. Whether a document is published is read from the document itself, not from its newest version, which is a draft whenever someone has saved one since it was published.
- After the write the gateway reads the document back as the public would get it. A document Payload still serves is reported as failed (`still_published`). The receipt lists `_status` in `changed_paths`, with `updated_at`, `version_id` and `details.preview_url`.
- To publish again, send `update_draft` with `publish: true` and no fields: it publishes the draft as it stands.

## Versions

`restore_version` brings back an earlier version of a document, and `restore_global_version` of a global:

```js
await payload.apply({
  intent: "Bring back the post as it was published",
  operations: [
    {
      kind: "restore_version",
      collection: "posts",
      id: 4,
      version_id: 32,
      expected_updated_at: post.updatedAt,
    },
  ],
});
```

- **The whole version comes back**, every field, through Payload's own restore route: `POST /api/{collection}/versions/{version_id}` (or `/api/globals/{slug}/versions/{version_id}`), as the approver. Find a document's versions with `findVersions` (`where: { parent: { equals: id } }`); a global's with `findGlobalVersions`, where the site's Payload offers it. A receipt's `version_id` is a version id too.
- **It is saved as a new draft, and what is published stays as it is.** The gateway always sends the restore with `draft=true` where the target keeps drafts. Without that flag Payload gives the document the status the version had, so restoring a version that was a draft would take a published document off the site.
- **`publish: true` publishes what was restored**, in a second write: the restore lands as a draft, then that draft is published the way `update_draft` with `publish: true` and no fields publishes one. It publishes only while the restored draft is still the newest save. If someone saved the document in between, or the second write fails, the receipt says `not_published` and the restored draft is still there.
- A global without drafts is live the moment it is restored, so there the operation is refused (`publish_required`) unless it says `publish: true`, and its approval carries the same warning as `update_global`. A collection without drafts is refused, as it is for every write.
- **The approval names the version** (its id, when it was saved, and whether it was published) **and shows each top-level field the restore changes**, before and after: rich text as Markdown, relationships by title, and an array or blocks field as a count of its rows with how many the restore adds, removes and changes. A version that holds what the document already holds is refused (`nothing_to_restore`).
- **`expected_updated_at` is required**, read with `draft: true` (a global with `findGlobalDraft`). A version of another document is refused (`version_of_another_document`), as is one that does not exist (`unknown_version`).
- **A document another editor has open is left alone** (`locked`). Payload's restore route does not look at editor locks, so the gateway asks the site's `getDocumentLock` tool when the approval is drawn and again just before it restores; a global's lock comes with `getEditingInfo`, as for `update_global`. A site without that tool gets no document restores (`lock_unknown`).
- On a site with locales, Payload restores every locale of the version. The approval says so, and shows the fields in one locale; a version that matches in that locale is still restored, since the others may differ. `publish: true` publishes every locale (`publishAllLocales=true`).
- A version of a file (an upload collection) cannot be restored (`not_supported`): replace the file with `replace_media_file`.
- The receipt lists the fields that changed, with `updated_at`, the `version_id` of the version the write made, `details.restored_version_id` and, for a document with a preview, `details.preview_url`.

## Trash

`trash` moves a document to the trash, and `restore_from_trash` takes it back out:

```js
await payload.apply({
  intent: "Take the cleanup day post off the site for good",
  operations: [
    {
      kind: "trash",
      collection: "posts",
      id: 4,
      expected_updated_at: post.updatedAt,
    },
  ],
});
```

- **Nothing is deleted for good.** The gateway never sends a `DELETE`: in Payload that removes a document and its versions, `?trash=true` included, where the flag only lets the delete reach a document already in the trash. `trash` is the save the admin's own Delete button sends on a collection that keeps a trash, `PATCH /api/{collection}/{id}` with `deletedAt` set to now, as the approver, and Payload asks for both update and delete permission. Emptying the trash stays in the admin.
- **Only a collection that keeps a trash takes it** (`trash: true` in its config, which `getEditingInfo` reports). Any other collection is refused (`trash_not_enabled`), since there the only delete is for good. So is a collection without drafts, as for every write, and an upload collection (`not_supported`).
- **A trashed document is gone from every read that does not ask for the trash**: the public site, the REST API and the read tools answer as if it did not exist. Read it with `findDocuments` and `trash: true` (`where: { deletedAt: { exists: true } }` lists only what is in the trash).
- **The approval warns that a public page goes away at once**, and names it: "The public page at /news/fall-cleanup-day goes away as soon as you approve, and links to it will 404. It moves to the trash, where it can be restored as a draft." Payload gives a trashed document the content of its newest version, so where a published document has a newer draft the warning adds that the draft is what comes back, not the page as published.
- **The approval lists documents that point at it**, in a "Linked from at least" row: up to five by collection, id and title, and a count of the rest, in which a document that points at it through two fields is counted once. The gateway asks Payload one query for each relationship or upload field outside any row that can hold the collection, twelve at most, as the editor. A link inside an array or blocks row, in rich text or in a global is not found, which is why the row says "at least". Those documents keep pointing at the trashed one; nothing is rewritten.
- **`restore_from_trash` brings it back as a draft**, so its public page stays away until someone publishes it: `PATCH /api/{collection}/{id}?trash=true` with `deletedAt: null` and `_status: "draft"`. With `publish: true` it is restored as published in the same write, as the admin's "restore as published" does, and the approval warns that the page comes back as soon as it is approved, holding what the document held when it went to the trash. On a site with locales either one applies to every locale.
- **`expected_updated_at` is required** on both. Read the document with `draft: true` before it is trashed, and with `trash: true` and `draft: true` while it is in the trash. A document already in the trash is refused (`already_in_trash`), as is restoring one that is not there (`not_in_trash`).
- **A document another editor has open is left alone** (`locked`): both are ordinary saves, so Payload answers 423 itself.
- After the write the gateway reads the document back. One that is not where the operation was to put it is reported as failed (`not_trashed`, `still_in_trash`, `not_published` when a restore with `publish: true` came back as a draft, or `still_published` when a restore as a draft came back published). The receipt lists `deletedAt` in `changed_paths` (and `_status` for a restore), with `updated_at`, `version_id` and, for a restore, `details.preview_url`.

## Locales

On a site whose Payload has `localization`, a localized field holds a value for each locale and every other field holds one value all locales share. An operation names the locale it works in:

```js
return payload.apply({
  intent: "Translate the fall cleanup post",
  operations: [
    {
      kind: "update_draft",
      collection: "posts",
      id: 4,
      locale: "es",
      expected_updated_at: post.updatedAt,
      fields: { title: "Día de limpieza de otoño" },
    },
  ],
});
```

- **`locale` goes on `update_draft`, `create_draft`, `patch_rows`, `update_global`, `upload_media`, `replace_media_file` and `unpublish`.** It is one of the codes in `describe_site`'s `localization.locales`. Restoring a version and the trash are about the whole document, every locale of it, and take no `locale`.
- **Without `locale` an operation writes the default locale**, with the same requests as on a site that has none. Nothing changes for a site without locales.
- **With `locale`, every REST request of the operation carries `locale=<code>&fallback-locale=none`**: the read the preview is built on, the write and the read back. So "before" is what that locale holds, empty where it has no value yet, never the default locale's text standing in for it.
- **A named locale changes that locale's value of each localized field, and the one shared value of every other field.** The approval marks each field with who it changes for: `title · es only`, `slug · every locale`. Which fields are localized comes from `getEditingInfo`'s `localizedFields`, for the document and for the rows of each array and blocks field. A row put into, taken out of or moved in a shared field is marked for every locale, since the row is there for all of them; inside a field that is itself localized, every change is for the one locale.
- **A locale that cannot be honoured is refused**, at the preview and again just before the write: a code the site does not have (`unknown_locale`), a site without locales or a collection or global with no localized field (`not_localized`), and a Payload whose `getEditingInfo` does not list `localizedFields` (`localized_fields_unknown`). Payload itself answers an unknown code by quietly using the default locale, which is why the gateway does not send one.
- **Publishing is by locale** where Payload keeps a status for each (it does, in any collection or global with drafts and a localized field; `_status` is then among `localizedFields`). `publish: true` publishes the operation's locale, or the default one when it names none, and the others stay as they are. `publish_all_locales: true` beside it publishes every locale, each with what its newest draft holds (`publishAllLocales=true`); it goes on `update_draft`, `patch_rows` and `update_global`. Its approval shows where each locale stands (`en: published, es: draft`), and after the write the gateway reads every locale back: one that is still a draft fails the operation (`not_published`), and one that was a draft counts as a change even where the operation's own locale was published already.
- **Publishing one locale still puts the shared fields live for all of them.** A draft holds the shared fields once, so a slug changed in a Spanish draft goes live in English when Spanish is published. The approval warns: "This publishes the es locale only. Fields marked “every locale” go live for all locales, along with shared changes saved in earlier drafts."
- **`unpublish` with a `locale` takes that locale down and leaves the others up**; the approval says so. Payload puts a newer draft's shared fields live here too, for the locales that stay published, so the gateway compares the published document with its newest draft and shows each shared field that differs as a row of its own, with a warning that names them: "A newer draft changes fields every locale shares (slug), and they go live for the locales that stay published as soon as you approve." The receipt lists them in `changed_paths` beside `_status`. Without a `locale` an unpublish takes down every locale, and the approval names them: `published in en, es`. Where a collection keeps one status for all locales, a `locale` on an unpublish is refused (`status_not_per_locale`).
- **The preview link and the public path are asked for in the operation's locale**: `getPreviewUrl` takes a `locale`, since a slug or the front end's routes can differ from one locale to the next. A Payload whose `getPreviewUrl` takes none gives a locale's operation no link.
- **Reads take a locale too.** Payload's `findDocuments`, `findVersions` and `findGlobal`, and this app's `findGlobalDraft`, take `locale` and `fallbackLocale`. Read with the operation's `locale` and `fallbackLocale: "none"` to see what that locale really holds. `updatedAt` is the document's, whatever the locale, so `expected_updated_at` works the same in all of them.
- **A locale with required fields needs them in the same write.** Where a collection validates drafts, Payload refuses a save in a locale whose required localized fields are still empty, and names them; the receipt carries that message (`write_failed`). Send the missing fields with the change.
- The receipt names the locale in `details.locale`.

## Files

A file never travels in an operation. A script stages it first and names it in `payload.apply` by the hash `stageUpload` returns:

```js
const file = await payload.stageUpload({
  collection: "media",
  source: { url: "https://images.example/library/harvest.jpg" },
});

return payload.apply({
  intent: "Add the harvest photo",
  operations: [
    {
      kind: "upload_media",
      collection: "media",
      upload_ref: file.upload_ref,
      fields: { alt: "Harvest day" },
    },
  ],
});
```

- **From a URL.** The gateway fetches it itself, over HTTPS only, and only when the collection's own `upload.pasteURL.allowList` in Payload allows it (matched the way Payload matches it). Every redirect is checked against the same list. A collection with no list takes no files by URL. The file may be as large as the collection allows, up to the gateway's 10 MB a file.
- **From base64**, as `source: { base64, filename, mimeType }`. The file travels inside the script, and a script is at most 20,000 characters, so this suits a file of up to about 14 KB (an icon, a small graphic). Anything larger has to come from a URL.
- The file's type is read from its bytes, never from what the caller says. A file that is not the type or extension it was declared as is refused, and so is a type the collection does not list in `upload.mimeTypes`, a file over Payload's `upload.limits.fileSize`, and every SVG.
- `upload_media` creates a document in an upload collection; `fields` holds its other fields, such as `alt`, and `filename` overrides the staged name. `replace_media_file` puts a new file on an existing document and must name the `expected_updated_at` it read. A replacement shows at once wherever the file is used (a file has no draft), so its approval carries a warning that also says whether the collection keeps the old file as an earlier version or deletes it.
- The approval shows the file as a `file` row: a thumbnail, its type, dimensions, size and the first characters of its SHA-256, with the file it replaces beside it. Thumbnails need the Cloudflare Images binding (`IMAGES` in `PayloadEnv`); without it the approval shows the same facts and no picture.
- After approval the file goes to Payload's own upload route as the approver, so Payload's access control, hooks, validation and storage adapter all run. The receipt lists `file` in `changed_paths` (and in `normalized_paths` when Payload stored it under another name or converted it), and gives the document's `id`, `filename` and `url` in `details`.

## Previews and receipts

- A relationship or upload field is previewed by name: `raised-beds.jpg (media 7)`, not `7`. Titles are read as the approver, from collections Payload described to them, at most 40 per preview.
- Where a collection has a front-end preview, the approval page links to the current draft beside the admin link, and the receipt carries the link in `details.preview_url`.
- A receipt for a write that landed carries `updated_at` (the next write's `expected_updated_at`), `version_id` (the version the write made, matched by the time Payload saved it, and left out when it cannot be told apart from someone else's save) and, for a new document, `details.id`. A document another editor has open in the admin is reported as `locked`, with nothing written.

It also gives `describe_site` what the editor can write to, from Payload's `getEditingInfo`: for each collection whether it keeps drafts, autosaves or has a trash, its rich text fields, its array and blocks fields with what a row of each holds (`rowFields`), its relationship and upload fields, what an upload collection accepts, and what the editor may create, update or delete; the same for globals, with whether another editor has each open (`locked`); and the site's locales, with the fields each collection, global and row keeps for each locale (`localizedFields`). A Payload that still runs the first `getEditingInfo` (five fields per collection) keeps working: everything newer reads as absent.

Payload is reached through a Service binding (`PAYLOAD`) or by URL through Access (`PAYLOAD_API_URL` with a service token). Either way the gateway forwards the Access JWT with a proof signed by `PAYLOAD_ACCESS_PROOF_SECRET`. Bindings are in `PayloadEnv` (`src/env.ts`). The Payload side is in [`apps/payload`](../../apps/payload): `@payloadcms/plugin-mcp` with read tools only, `accessGatewayAuthStrategy` from `@patronage/access/payload` on the users collection, and the `getEditingInfo`, `getPreviewUrl`, `markdownToRichText` and `richTextToMarkdown` tools (`src/mcp-tools.ts`, with `src/lib/editing-info.ts`). `patch_rows` needs the two rich text tools to take a `path` for a field inside a row. `payload.apply` needs `getEditingInfo` and refuses writes without it; `getPreviewUrl` is optional, and without it no preview link is offered. `IMAGES`, the Cloudflare Images binding, is optional too: it measures an uploaded picture and makes its thumbnail.

```ts
import { payloadConnector } from "@patronage/mcp-payload";
```
