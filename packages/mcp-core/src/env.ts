// The bindings the gateway itself reads. A deployment's own `Env` holds these
// and each connector's (`WordPressEnv`, `PayloadEnv`) beside them.
export interface GatewayEnv {
  // The Access application in front of the gateway.
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  // "true" offers the approval card to clients that never advertised MCP
  // Apps support. Off unless set.
  APPROVAL_CARD_FOR_UNKNOWN_CLIENTS?: string;
  // Signs the approval page's form tokens. Only a deployment with
  // `APPROVAL_REQUIRED` needs it; there, every approval fails closed without
  // it.
  APPROVAL_CSRF_SECRET?: string;
  // "true" holds every write for Approval: a person sees the before-and-after
  // on the card or the approval page, and the write runs once they accept it.
  // Unset or "false", a write is applied as soon as the model's code calls
  // `apply`, as the signed-in person. Any other value reads as "true", so a
  // mistyped setting never drops the Approval a site asked for.
  APPROVAL_REQUIRED?: string;
  DEPLOYMENT_ENVIRONMENT?: string;
  // Bound to the deployment's `BaseGatewayRuntime` subclass.
  GATEWAY_RUNTIME: DurableObjectNamespace;
  // Runs model-written code in a Dynamic Worker.
  LOADER: WorkerLoader;
  // Hostnames the MCP endpoint answers on, comma separated.
  MCP_ALLOWED_HOSTNAMES?: string;
  // The Worker's own name, logged as the wide event's `service`.
  WORKER_NAME?: string;
}
