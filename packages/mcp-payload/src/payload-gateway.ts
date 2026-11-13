import type { GatewayConnector } from "@patronage/mcp-core";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadConfigured } from "./payload";
import { preflightDraftOperations } from "./payload-apply";
import { readEditingInfo } from "./payload-editing";
import { draftSentence, parseDraftApplyInput } from "./payload-operations";
import {
  createPayloadTools,
  payloadAdminLink,
  payloadSiteLink,
  PAYLOAD_CONNECTOR_INSTRUCTIONS,
} from "./payload-tools";

const PAYLOAD_EXECUTE_DESCRIPTION = [
  "The payload global reaches the Payload CMS.",
  'Payload reads: await payload.tools() lists the read tools; await payload.call({ tool: "findDocuments", arguments: { slug: "posts", where: { slug: { equals: "hello" } }, draft: true } }) returns { isError, text, structured? } with the documents as JSON in text.',
  'Payload writes: await payload.apply({ intent, operations }), with 1-20 operations shaped { kind: "update_draft", collection, id, fields?, markdown?, publish?, expected_updated_at? } or { kind: "create_draft", collection, fields?, markdown?, publish? }; each is saved as a draft after human approval, and published only when it sets publish: true, which you add only when the person asked to publish. Put rich text fields in markdown as Markdown text; describe_site lists them under payload.collections[].richTextFields. Copy updatedAt from a draft: true read into expected_updated_at.',
].join(" ");

// The Payload connector: Payload's own read tools over its MCP endpoint, and
// draft writes through the approval step.
export const payloadConnector: GatewayConnector<PayloadEnv> = {
  configured: payloadConfigured,
  // The collections and globals this editor can read: which keep drafts,
  // which fields take Markdown or hold rows, what an upload collection
  // accepts, and the site's locales.
  describe: async (env, caller, telemetry) => {
    const info = await readEditingInfo(
      createPayloadClient(env, caller),
      telemetry
    );

    // Parsed and passed on whole; `describe_site` bounds what a text-only
    // client is shown.
    return {
      collections: info.collections,
      globals: info.globals,
      localization: info.localization,
    };
  },
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
      telemetry,
      payloadSiteLink(env)
    );
  },
  tools: createPayloadTools,
};
