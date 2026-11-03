# @patronage/mcp-core

An MCP gateway for Cloudflare Workers. People sign in through Cloudflare Access, the model reads the CMS as that person through code mode, and every write pauses until a person approves a before-and-after ([ADR 0014](../../docs/adr/0014-mcp-gateway-worker.md)).

Core names no CMS. Each backend is a connector, such as [`@patronage/mcp-wordpress`](../mcp-wordpress) or [`@patronage/mcp-payload`](../mcp-payload), and a deployment lists the ones it has.

## Use

```ts
import { createWorker } from "@patronage/mcp-core";
import { BaseGatewayRuntime } from "@patronage/mcp-core/runtime";
import { wordpressConnector } from "@patronage/mcp-wordpress";

export { CodemodeRuntime } from "@cloudflare/codemode";

const connectors = [wordpressConnector];

export class GatewayRuntime extends BaseGatewayRuntime<Env> {
  protected readonly connectors = connectors;
}

export default createWorker<Env>({ connectors });
```

The Worker needs the bindings in `GatewayEnv` (`src/env.ts`): `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` for the Access application in front of it, `GATEWAY_RUNTIME` bound to the `GatewayRuntime` class above, a `LOADER` Worker Loader (Dynamic Workers), and `APPROVAL_CSRF_SECRET`. Each connector adds its own. [`apps/mcp`](../../apps/mcp) is the reference deployment.

The Durable Object's class name belongs to the deployment. A gateway that already runs with another class name (such as `WordPressRuntime`, from the template this came from) should keep that name for its subclass, because Cloudflare keys a Durable Object namespace's stored runs and pending approvals to the class. Renaming it needs an explicit rename migration.

## A connector

A connector implements `GatewayConnector` (`src/gateway-connector.ts`): its sandbox name, a paragraph for the `execute` tool description, its tools, and for writes `parseApply` (validate and summarise) and `preflight` (the before-and-after the approver sees). `src/upstream.ts` has the shared fetch client, which forwards the caller's Access JWT with a gateway proof and records each request on the wide event.

## Commands

```sh
pnpm generate   # bundle the approval card's client (gitignored)
pnpm test
pnpm typecheck
pnpm build      # dist/ for npm
```
