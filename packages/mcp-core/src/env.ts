// The bindings the gateway itself reads. A deployment's own `Env` holds these
// and each connector's (`WordPressEnv`, `PayloadEnv`) beside them.
export interface GatewayEnv {
  // The Access application in front of the gateway.
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  // "true" offers the approval card to clients that never advertised MCP
  // Apps support. Off unless set.
  APPROVAL_CARD_FOR_UNKNOWN_CLIENTS?: string;
  // Signs the approval page's form tokens. Without it every approval fails
  // closed.
  APPROVAL_CSRF_SECRET?: string;
  DEPLOYMENT_ENVIRONMENT?: string;
  // Turns on the maintainer's `/mcp/feedback` routes. Without it they answer
  // 404, and agents can still submit feedback.
  FEEDBACK_MAINTAINER_TOKEN?: string;
  // Bound to the deployment's `BaseGatewayRuntime` subclass.
  GATEWAY_RUNTIME: DurableObjectNamespace;
  // Runs model-written code in a Dynamic Worker.
  LOADER: WorkerLoader;
  // Hostnames the MCP endpoint answers on, comma separated.
  MCP_ALLOWED_HOSTNAMES?: string;
  // The Worker's own name, logged as the wide event's `service`.
  WORKER_NAME?: string;
}
