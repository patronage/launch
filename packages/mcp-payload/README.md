# @patronage/mcp-payload

The Payload connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `payload`:

- `payload.tools()` and `payload.call({ tool, arguments })` run Payload's own read tools at `/api/mcp` as the signed-in editor. Only read tools are allowed.
- `payload.apply({ intent, operations })` stages `update_draft` and `create_draft` operations for approval. Approved changes are saved as drafts unless an operation sets `publish: true`, which the approval card shows as a `_status` change to `published`.
- Rich text fields can be written as Markdown, converted with the field's own editor features.
- A `patch_rows` operation changes, inserts, removes or moves single rows of an array or blocks field by row id, without resending the field.
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

It also gives `describe_site` what the editor can write to, from Payload's `getEditingInfo`: for each collection whether it keeps drafts, autosaves or has a trash, its rich text fields, its array and blocks fields with what a row of each holds (`rowFields`), its relationship and upload fields, what an upload collection accepts, and what the editor may create, update or delete; the same for globals; and the site's locales. A Payload that still runs the first `getEditingInfo` (five fields per collection) keeps working: everything newer reads as absent.

Payload is reached through a Service binding (`PAYLOAD`) or by URL through Access (`PAYLOAD_API_URL` with a service token). Either way the gateway forwards the Access JWT with a proof signed by `PAYLOAD_ACCESS_PROOF_SECRET`. Bindings are in `PayloadEnv` (`src/env.ts`). The Payload side is in [`apps/payload`](../../apps/payload): `@payloadcms/plugin-mcp` with read tools only, `accessGatewayAuthStrategy` from `@patronage/access/payload` on the users collection, and the `getEditingInfo`, `getPreviewUrl`, `markdownToRichText` and `richTextToMarkdown` tools (`src/mcp-tools.ts`, with `src/lib/editing-info.ts`). `patch_rows` needs the two rich text tools to take a `path` for a field inside a row. `payload.apply` needs `getEditingInfo` and refuses writes without it; `getPreviewUrl` is optional, and without it no preview link is offered. `IMAGES`, the Cloudflare Images binding, is optional too: it measures an uploaded picture and makes its thumbnail.

```ts
import { payloadConnector } from "@patronage/mcp-payload";
```
