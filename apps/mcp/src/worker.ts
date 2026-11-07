import { createWorker } from "@patronage/mcp-core";
import { BaseGatewayRuntime } from "@patronage/mcp-core/runtime";
import { payloadConnector } from "@patronage/mcp-payload";
import { wordpressConnector } from "@patronage/mcp-wordpress";

export { CodemodeRuntime } from "@cloudflare/codemode";

const connectors = [wordpressConnector, payloadConnector];

export class GatewayRuntime extends BaseGatewayRuntime<Env> {
  protected readonly connectors = connectors;
}

export default createWorker<Env>({ connectors }) satisfies ExportedHandler<Env>;
