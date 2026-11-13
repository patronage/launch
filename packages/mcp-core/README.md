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

An approved write gets 5 minutes in the sandbox and an ordinary run gets 60 seconds (`approvalTimeoutMs` and `executionTimeoutMs` on `BaseGatewayRuntime`). The approval waits for the write itself, not only for the sandbox, so a script that times out after its write still reports the write's receipt. A connector's `apply` should call `store.recordProgress` as each operation settles: that drives the progress on the approval page and card, and is the record of what landed if a write is cut off. `mapWithConcurrency` and `APPLY_CONCURRENCY` run a batch's operations two at a time.

A connector implements `GatewayConnector` (`src/gateway-connector.ts`): its sandbox name, a paragraph for the `execute` tool description, its tools, and for writes `parseApply` (validate and summarise) and `preflight` (the before-and-after the approver sees). `src/upstream.ts` has the shared fetch client, which forwards the caller's Access JWT with a gateway proof and records each request on the wide event.

What a preview and a receipt can carry, all optional (`src/apply.ts`):

- **A thumbnail** beside a value: `beforeImage` and `afterImage` on a `FieldSnapshot`, with the file's type, size, dimensions and hash. Both surfaces draw the picture only when `src` is a WebP `data:` URL of at most 24 KB (`isThumbnailSrc`); anything else shows the facts alone. Neither surface ever loads an image from a URL.
- **A label** for a row path, so `layout[id=…].cards[id=…].title` reads as "Sections › Card grid (row 3) › Cards › row 2 › Title". `NEW_ROW` and `REMOVED_ROW` fill the side of a snapshot where the row does not exist.
- **A warning** on an operation that changes what the public sees as soon as it is approved.
- **A preview link**: `previewUrl` on an operation, where the CMS can show the target as it is now on the front end, drafts included. The approval page offers it beside the edit link, over HTTPS only.
- **Receipt facts**: `version_id`, `updated_at`, and up to eight bounded `details` (build them with `receiptDetails`), such as a new document's id or a file's URL. Never a field value.

A file a write needs is staged, never passed to `apply`: tool arguments go into the durable log, where one value holds at most 2 MB. A read-phase tool calls `store.stageBlob(executionId, bytes, facts)` and returns the SHA-256 it gets back; `apply` names that hash and reads the bytes with `store.readBlob`, and `preflight` reads the facts with `store.readBlobMeta` from its `context`. Only the run that staged a file can read it. One file may be 10 MB and one run 25 MB (`maxBlobBytes` and `maxRunBlobBytes` on `BaseGatewayRuntime` lower them), and a run's files are deleted when it ends, is rejected or expires.

## Commands

```sh
pnpm generate   # bundle the approval card's client (gitignored)
pnpm test
pnpm typecheck
pnpm build      # dist/ for npm
```
