import type { ApplyPreflight } from "./apply";
import type { CallerContext } from "./caller";
import type { ConnectorDeps, ConnectorToolMap } from "./connector";
import type { GatewayEnv } from "./env";
import type { PendingApplySummary } from "./run";
import type { UpstreamTelemetry } from "./upstream";

// One backend the gateway can reach, as the runtime sees it. The runtime
// names no CMS: a deployment passes the connectors it has, and each one
// brings its sandbox global, its tools, the validation and preview for its
// `apply`, and its part of `describe_site`.
export interface GatewayConnector<E = GatewayEnv> {
  // A short paragraph for the `execute` tool description: how the model
  // reads and writes through this connector.
  readonly executeDescription: string;
  // The connector's own instructions inside the sandbox.
  readonly instructions: string;
  // The sandbox global, such as `wp` or `payload`.
  readonly name: string;
  // Whether this deployment has the backend at all. One that is not
  // configured is left out of the sandbox and of `describe_site`.
  configured: (env: E) => boolean;
  // This connector's part of `describe_site`, as the caller sees the site.
  describe?: (
    env: E,
    caller: CallerContext,
    telemetry: UpstreamTelemetry
  ) => Promise<object>;
  // Validates `apply` arguments, throwing `ApplyValidationError`, and
  // summarises them for the paused result.
  parseApply: <T>(args: T) => PendingApplySummary;
  // The before-and-after a person approves, read as that person.
  preflight: <T>(
    env: E,
    caller: CallerContext,
    args: T,
    telemetry: UpstreamTelemetry
  ) => Promise<ApplyPreflight>;
  tools: (deps: ConnectorDeps<E>) => ConnectorToolMap;
}
