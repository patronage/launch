import { CodemodeConnector } from "@cloudflare/codemode";
import type { ConnectorTools } from "@cloudflare/codemode";

import type { ConnectorToolMap } from "./connector";
import type { GatewayConnector } from "./gateway-connector";

// The codemode connector for any `GatewayConnector`: its name, its
// instructions and the tools it built for this call.
export class ToolMapConnector<E> extends CodemodeConnector<E> {
  readonly #instructions: string;
  readonly #name: string;
  readonly #tools: ConnectorToolMap;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    env: E,
    connector: Pick<GatewayConnector<E>, "instructions" | "name">,
    tools: ConnectorToolMap
  ) {
    super(ctx, env);
    this.#instructions = connector.instructions;
    this.#name = connector.name;
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
