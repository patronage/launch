import type { ApplyPreflight, BatchReceipt, OperationReceipt } from "./apply";
import type { CallerScope } from "./caller";
import type { GatewayEnv } from "./env";
import type { StagedBlob, StagedBlobFacts } from "./staged-blobs";
import type { JsonValue, UpstreamTelemetry } from "./upstream";

// The contract between the code-mode runtime and a connector's tools: what
// a tool declares, what it is handed per call, and the store a connector's
// `apply` reads its approved preview from.

// The JSON Schema subset these tools declare. Written out rather than borrowed
// from the codemode package so the module stays import-free, and structurally
// assignable to that package's `JSONSchema7` input schema.
export interface ConnectorInputSchema {
  items?: ConnectorInputSchema;
  properties?: Record<string, ConnectorInputSchema>;
  required?: string[];
  type:
    | "array"
    | "boolean"
    | "integer"
    | "null"
    | "number"
    | "object"
    | "string";
}

export interface ToolCallContext {
  executionId?: string;
}

export type ConnectorToolResult = BatchReceipt | JsonValue;

export interface ConnectorToolDefinition {
  description: string;
  // Arguments arrive as JSON from the codemode durable log; the unconstrained
  // generic is the repo's stand-in for the banned `unknown` parameter, and it
  // keeps the definition assignable to the codemode package's own tool type.
  execute: <T>(args: T, ctx?: ToolCallContext) => Promise<ConnectorToolResult>;
  inputSchema: ConnectorInputSchema;
  requiresApproval?: boolean;
}

export type ConnectorToolMap = Record<string, ConnectorToolDefinition>;

export interface RuntimeStore {
  // The bytes and the facts of a file this run staged, by its SHA-256, or
  // nothing when this run staged no such file. Optional, like the two beside
  // it, so a store written before staged files existed keeps compiling; the
  // gateway's own store has all three.
  readBlob?: (
    executionId: string,
    sha256: string
  ) => Promise<{ blob: StagedBlob; bytes: Uint8Array } | undefined>;
  // The same facts without the bytes, for a preview.
  readBlobMeta?: (
    executionId: string,
    sha256: string
  ) => Promise<StagedBlob | undefined>;
  readPreflight: (executionId: string) => Promise<ApplyPreflight | undefined>;
  readRequester: (executionId: string) => Promise<string | undefined>;
  // Called by a connector's `apply` as each operation settles, so a run that
  // stops before `apply` returns still has a record of what landed, and the
  // approval surfaces can show progress while it runs. Optional so a
  // connector written before it existed keeps compiling.
  recordProgress?: (
    executionId: string,
    receipt: OperationReceipt
  ) => Promise<void>;
  // Keeps a file for a later `apply` in the same run, which names it by the
  // hash returned here. Upload bytes go through this and never through
  // `apply`'s arguments. Throws `StagedBlobError` over the size limits.
  stageBlob?: (
    executionId: string,
    bytes: Uint8Array,
    facts: StagedBlobFacts
  ) => Promise<StagedBlob>;
  writePreflight: (
    executionId: string,
    preflight: ApplyPreflight
  ) => Promise<void>;
}

export interface ConnectorDeps<E = GatewayEnv> {
  env: E;
  scope: CallerScope;
  store: RuntimeStore;
  // The telemetry for the RPC these tools are running under. A getter rather
  // than a value so the Durable Object can build the tools once per call and
  // still hand every request in that call to the same collector — the Worker
  // reads it back off the RPC result and puts it on the wide event.
  telemetry: () => UpstreamTelemetry;
}
