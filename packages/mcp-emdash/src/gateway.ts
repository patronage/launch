import { ApplyValidationError } from "@patronage/mcp-core";
import type { GatewayConnector } from "@patronage/mcp-core";

import { describeEmDash } from "./describe";
import { createEmDashClient, emdashConfigured } from "./emdash";
import {
  createEmDashTools,
  EMDASH_CONNECTOR_INSTRUCTIONS,
  EMDASH_EXECUTE_DESCRIPTION,
} from "./emdash-tools";
import type { EmDashEnv } from "./env";

const noWrites = (): never => {
  throw new ApplyValidationError(
    "not_supported",
    "EmDash has no writes through the gateway yet; change it in the EmDash admin"
  );
};

// The EmDash connector: EmDash's REST API read as the signed-in editor. It
// offers no `apply` yet, so its validation and preview refuse every batch.
export const emdashConnector: GatewayConnector<EmDashEnv> = {
  configured: emdashConfigured,
  describe: (env, caller, telemetry) =>
    describeEmDash(createEmDashClient(env, caller), telemetry),
  executeDescription: EMDASH_EXECUTE_DESCRIPTION,
  instructions: EMDASH_CONNECTOR_INSTRUCTIONS,
  name: "emdash",
  parseApply: noWrites,
  preflight: noWrites,
  tools: createEmDashTools,
};
