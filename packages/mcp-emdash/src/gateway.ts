import type { GatewayConnector } from "@patronage/mcp-core";

import { describeEmDash } from "./describe";
import { createEmDashClient, emdashConfigured } from "./emdash";
import { preflightOperations } from "./emdash-apply";
import { operationSentence, parseApplyInput } from "./emdash-operations";
import {
  createEmDashTools,
  EMDASH_CONNECTOR_INSTRUCTIONS,
  EMDASH_EXECUTE_DESCRIPTION,
  emdashLinks,
} from "./emdash-tools";
import type { EmDashEnv } from "./env";

// The EmDash connector: EmDash's REST API read as the signed-in editor, and
// draft saves, new drafts and publishes through the approval step (ADR 0027).
export const emdashConnector: GatewayConnector<EmDashEnv> = {
  configured: emdashConfigured,
  describe: (env, caller, telemetry) =>
    describeEmDash(createEmDashClient(env, caller), telemetry),
  executeDescription: EMDASH_EXECUTE_DESCRIPTION,
  instructions: EMDASH_CONNECTOR_INSTRUCTIONS,
  name: "emdash",
  parseApply: (args) => {
    const input = parseApplyInput(args);

    return {
      intent: input.intent,
      sentences: input.operations.map((operation, index) =>
        operationSentence(operation, index)
      ),
    };
  },
  preflight: (env, caller, args, telemetry) => {
    const input = parseApplyInput(args);

    return preflightOperations(
      createEmDashClient(env, caller),
      input.intent,
      input.operations,
      emdashLinks(env),
      telemetry
    );
  },
  tools: createEmDashTools,
};
