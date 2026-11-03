import type { GatewayConnector } from "@patronage/mcp-core";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadConfigured } from "./payload";
import { preflightDraftOperations, readEditingInfo } from "./payload-apply";
import { draftSentence, parseDraftApplyInput } from "./payload-operations";
import {
  createPayloadTools,
  payloadAdminLink,
  PAYLOAD_CONNECTOR_INSTRUCTIONS,
} from "./payload-tools";

const PAYLOAD_EXECUTE_DESCRIPTION = [
  "The payload global reaches the Payload CMS.",
  'Payload reads: await payload.tools() lists the read tools; await payload.call({ tool: "findDocuments", arguments: { slug: "posts", where: { slug: { equals: "hello" } }, draft: true } }) returns { isError, text, structured? } with the documents as JSON in text.',
  'Payload writes: await payload.apply({ intent, operations }), with 1-20 operations shaped { kind: "update_draft", collection, id, fields?, markdown?, expected_updated_at? } or { kind: "create_draft", collection, fields?, markdown? }; each is saved as a draft, never published, after human approval. Put rich text fields in markdown as Markdown text; describe_site lists them under payload.collections[].richTextFields. Copy updatedAt from a draft: true read into expected_updated_at.',
].join(" ");

// The Payload connector: Payload's own read tools over its MCP endpoint, and
// draft writes through the approval step.
export const payloadConnector: GatewayConnector<PayloadEnv> = {
  configured: payloadConfigured,
  // The collections this editor can read, which keep drafts, and which
  // fields take Markdown.
  describe: async (env, caller, telemetry) => ({
    collections: await readEditingInfo(
      createPayloadClient(env, caller),
      telemetry
    ),
  }),
  executeDescription: PAYLOAD_EXECUTE_DESCRIPTION,
  instructions: PAYLOAD_CONNECTOR_INSTRUCTIONS,
  name: "payload",
  parseApply: (args) => {
    const input = parseDraftApplyInput(args);

    return {
      intent: input.intent,
      sentences: input.operations.map((operation) => draftSentence(operation)),
    };
  },
  preflight: (env, caller, args, telemetry) => {
    const input = parseDraftApplyInput(args);

    return preflightDraftOperations(
      createPayloadClient(env, caller),
      input.intent,
      input.operations,
      payloadAdminLink(env),
      telemetry
    );
  },
  tools: createPayloadTools,
};
