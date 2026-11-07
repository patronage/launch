# @patronage/mcp-payload

The Payload connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `payload`:

- `payload.tools()` and `payload.call({ tool, arguments })` run Payload's own read tools at `/api/mcp` as the signed-in editor. Only read tools are allowed.
- `payload.apply({ intent, operations })` stages `update_draft` and `create_draft` operations for approval. Approved changes are saved as drafts unless an operation sets `publish: true`, which the approval card shows as a `_status` change to `published`.
- Rich text fields can be written as Markdown, converted with the field's own editor features.

It also gives `describe_site` the collections the editor can read.

Payload is reached through a Service binding (`PAYLOAD`) or by URL through Access (`PAYLOAD_API_URL` with a service token). Either way the gateway forwards the Access JWT with a proof signed by `PAYLOAD_ACCESS_PROOF_SECRET`. Bindings are in `PayloadEnv` (`src/env.ts`). The Payload side is in [`apps/payload`](../../apps/payload): `@payloadcms/plugin-mcp` with read tools only, `accessGatewayAuthStrategy` from `@patronage/access/payload` on the users collection, and the `getEditingInfo`, `markdownToRichText` and `richTextToMarkdown` tools (`src/mcp-tools.ts`). `payload.apply` needs `getEditingInfo` and refuses writes without it.

```ts
import { payloadConnector } from "@patronage/mcp-payload";
```
