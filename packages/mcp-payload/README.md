# @patronage/mcp-payload

The Payload connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `payload`:

- `payload.tools()` and `payload.call({ tool, arguments })` run Payload's own read tools at `/api/mcp` as the signed-in editor. Only read tools are allowed.
- `payload.apply({ intent, operations })` stages `update_draft` and `create_draft` operations for approval. Approved changes are saved as drafts unless an operation sets `publish: true`, which the approval card shows as a `_status` change to `published`.
- Rich text fields can be written as Markdown, converted with the field's own editor features.

- A relationship or upload field is previewed by name: `raised-beds.jpg (media 7)`, not `7`. Titles are read as the approver, from collections Payload described to them, at most 40 per preview.
- Where a collection has a front-end preview, the approval page links to the current draft beside the admin link, and the receipt carries the link in `details.preview_url`.
- A receipt for a write that landed carries `updated_at` (the next write's `expected_updated_at`), `version_id` (the version the write made) and, for a new document, `details.id`. A document another editor has open in the admin is reported as `locked`, with nothing written.

It also gives `describe_site` what the editor can write to, from Payload's `getEditingInfo`: for each collection whether it keeps drafts, autosaves or has a trash, its rich text fields, its array and blocks fields with what a row of each holds (`rowFields`), its relationship and upload fields, what an upload collection accepts, and what the editor may create, update or delete; the same for globals; and the site's locales. A Payload that still runs the first `getEditingInfo` (five fields per collection) keeps working: everything newer reads as absent.

Payload is reached through a Service binding (`PAYLOAD`) or by URL through Access (`PAYLOAD_API_URL` with a service token). Either way the gateway forwards the Access JWT with a proof signed by `PAYLOAD_ACCESS_PROOF_SECRET`. Bindings are in `PayloadEnv` (`src/env.ts`). The Payload side is in [`apps/payload`](../../apps/payload): `@payloadcms/plugin-mcp` with read tools only, `accessGatewayAuthStrategy` from `@patronage/access/payload` on the users collection, and the `getEditingInfo`, `getPreviewUrl`, `markdownToRichText` and `richTextToMarkdown` tools (`src/mcp-tools.ts`, with `src/lib/editing-info.ts`). `payload.apply` needs `getEditingInfo` and refuses writes without it; `getPreviewUrl` is optional, and without it no preview link is offered.

```ts
import { payloadConnector } from "@patronage/mcp-payload";
```
