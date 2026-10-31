import { CodemodeConnector } from "@cloudflare/codemode";
import type { ConnectorTools } from "@cloudflare/codemode";

import type { ConnectorToolMap } from "./connector";
import { PAYLOAD_CONNECTOR_INSTRUCTIONS } from "./payload-tools";

// The `payload` global the model's code calls, beside `wp`. Like
// `WordPressConnector`, its tools close over the caller scope the Durable
// Object owns, so they are handed in rather than built here.
export class PayloadConnector extends CodemodeConnector<Env> {
  readonly #instructions = PAYLOAD_CONNECTOR_INSTRUCTIONS;
  readonly #name = "payload";
  readonly #tools: ConnectorToolMap;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    env: Env,
    tools: ConnectorToolMap
  ) {
    super(ctx, env);
    this.#tools = tools;
  }

  name(): string {
    return this.#name;
  }

  protected instructions(): string {
    return this.#instructions;
  }

  protected tools(): ConnectorTools {
    return this.#tools;
  }
}
