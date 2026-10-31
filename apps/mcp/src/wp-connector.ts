import { CodemodeConnector } from "@cloudflare/codemode";
import type { ConnectorTools } from "@cloudflare/codemode";

import { WP_CONNECTOR_INSTRUCTIONS } from "./connector";
import type { ConnectorToolMap } from "./connector";

// The adapter between the package-free tool definitions in `connector.ts` and
// the codemode package. It lives in its own file for two reasons: `runtime.ts`
// may hold only one class, and `connector.ts` must keep naming no codemode
// import so its tools stay testable with a stubbed `fetch` alone.
//
// The three answers a connector owes the runtime — the global name the model
// calls, the guidance it reads, and the tools it can reach — are all instance
// state, because the tools close over the caller scope the Durable Object owns
// and only the Durable Object can build them.
export class WordPressConnector extends CodemodeConnector<Env> {
  readonly #instructions = WP_CONNECTOR_INSTRUCTIONS;
  readonly #name = "wp";
  readonly #tools: ConnectorToolMap;

  // `CodemodeConnector` widens its first parameter to accept a Durable
  // Object's state, so `this.ctx` passes through with no cast.
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
