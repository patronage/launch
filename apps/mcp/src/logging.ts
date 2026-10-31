import type { AuditableLogger, DrainContext, RedactConfig } from "evlog";
import { initWorkersLogger, withEvlog } from "evlog/workers";
import type {
  EvlogWorkersOptions,
  WorkerExecutionContext,
} from "evlog/workers";
import { z } from "zod";

import type { BatchReceipt, OperationReceipt } from "./apply";
import type { ExecuteResult } from "./run";

const MAX_PATH = 128;
const SERVICE_VERSION = "0.1.0";

const REDACTION: RedactConfig = {
  paths: [
    "**.authorization",
    "**.body",
    "**.content",
    "**.cookie",
    "**.headers",
    "**.password",
    "**.query",
    "**.secret",
    "**.token",
  ],
};

export type AuthenticationOutcome =
  | "allowed"
  | "challenged"
  | "denied"
  | "pending";

export type McpOutcome = "error" | "not_found" | "pending" | "success";

export type StreamOutcome =
  | "cancelled"
  | "completed"
  | "errored"
  | "not_started"
  | "not_streamed"
  | "pending";

export interface WordPressRequestEvent {
  durationMs: number;
  errorCode?: string;
  method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT" | "OTHER";
  outcome: "error" | "success";
  path: string;
  status: number;
}

export const wordpressActorSchema = z.object({
  id: z.number().int().positive(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .refine((value) =>
      [...value].every((character) => {
        const point = character.codePointAt(0) ?? 0;

        return point > 31 && point !== 127;
      })
    ),
});

export type WordPressActor = z.infer<typeof wordpressActorSchema>;

// The wide event's whole record of one request's WordPress traffic. It is also
// what the Durable Object hands back over RPC, because the Worker is no longer
// the side that makes the requests: nothing here is a body, a token, or a
// query string, and `truncated` counts the records a busy run dropped rather
// than growing the event without bound.
export interface WordPressRequestLog {
  actor?: WordPressActor;
  auth: "access-jwt";
  requests: WordPressRequestEvent[];
  target: string;
  truncated?: number;
}

export interface McpWideEvent {
  approval?: {
    actor?: string;
    approverOpaque?: string;
    decision?: "approve" | "reject";
    executionId?: string;
    outcome: "approved" | "denied" | "not_required";
    source?: string;
    targets?: string[];
    wordpressActor?: WordPressActor;
  };
  authentication: {
    actor: string;
    outcome: AuthenticationOutcome;
    reason?: string;
  };
  deployment: {
    environment: string;
  };
  http: {
    outcome: "client_error" | "server_error" | "success";
    status: number;
    stream: {
      outcome: StreamOutcome;
    };
  };
  mcp: {
    durationMs?: number;
    // The class name of a failure whose message the caller was not given. It
    // is the only trace of what went wrong, and a class name carries no
    // upstream text.
    errorName?: string;
    outcome: McpOutcome;
    tool?: string;
    transport: "streamable-http";
  };
  plugin?: {
    download?: {
      durationMs: number;
      outcome: "error" | "success";
      package: string;
      version: string;
    };
  };
  response?: {
    complete: boolean;
    payloadBytes: number;
    returnedItems: number;
  };
  run?: {
    executionId: string;
    pausedOn?: string;
    status: "complete" | "error" | "paused";
    toolCalls: number;
  };
  wordpress?: WordPressRequestLog;
  write?: {
    action: string;
    changed?: number;
    conflict?: number;
    durationMs?: number;
    failed?: number;
    normalized?: number;
    outcome: "denied" | "error" | "success";
    target: string;
    targets?: string[];
    unchanged?: number;
  };
}

export type McpRequestLogger<TConsumer extends object = Record<never, never>> =
  AuditableLogger<McpWideEvent & { consumer?: TConsumer }>;

export interface ConsumerWriteEvent {
  approval: NonNullable<McpWideEvent["approval"]>;
  write: NonNullable<McpWideEvent["write"]>;
}

export type PluginDownloadEvent = NonNullable<
  NonNullable<McpWideEvent["plugin"]>["download"]
>;

type McpRequestHandler<TConsumer extends object> = (
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  log: McpRequestLogger<TConsumer>
) => Promise<Response> | Response;

export interface McpLoggingOptions {
  drain?: (context: DrainContext) => Promise<void> | void;
}

initWorkersLogger({
  env: {
    environment: "cloudflare-workers",
    service: "launch-mcp",
    version: SERVICE_VERSION,
  },
  redact: REDACTION,
});

const httpOutcome = (status: number): McpWideEvent["http"]["outcome"] => {
  if (status >= 500) {
    return "server_error";
  }

  return status >= 400 ? "client_error" : "success";
};

const boundedTarget = (value: string): string => {
  let target = value;

  if (/^https?:\/\//iu.test(value)) {
    try {
      target = new URL(value).pathname;
    } catch {
      return "unknown";
    }
  }

  const withoutQuery = target.split(/[?#]/u, 1)[0] || "unknown";

  return withoutQuery.length > MAX_PATH
    ? `${withoutQuery.slice(0, MAX_PATH)}…`
    : withoutQuery;
};

export const recordPluginDownload = <TConsumer extends object>(
  log: McpRequestLogger<TConsumer>,
  download: PluginDownloadEvent
): void => {
  log.set({ plugin: { download } });
};

export const recordConsumerWrite = <TConsumer extends object>(
  log: McpRequestLogger<TConsumer>,
  event: ConsumerWriteEvent
): void => {
  const target = boundedTarget(event.write.target);

  const actor =
    event.approval.actor ?? log.getContext().authentication?.actor ?? "unknown";

  log.set({
    approval: event.approval,
    write: { ...event.write, target },
  });

  const audit = {
    action: event.write.action,
    actor: { id: actor, type: "user" as const },
    target: { id: target, type: "wordpress" },
  };

  if (event.write.outcome === "denied") {
    log.audit.deny("write_denied", audit);

    return;
  }

  log.audit({
    ...audit,
    outcome: event.write.outcome === "success" ? "success" : "failure",
  });
};

// The Durable Object makes every WordPress request now, so the records reach
// the wide event over RPC rather than from `wpFetch` in this process. Evlog
// merges arrays, so two RPCs in one HTTP request contribute both their records.
export const recordWordPressRequests = <TConsumer extends object>(
  log: McpRequestLogger<TConsumer>,
  wordpress: WordPressRequestLog | undefined
): void => {
  if (wordpress) {
    log.set({ wordpress });
  }
};

export const recordRun = <TConsumer extends object>(
  log: McpRequestLogger<TConsumer>,
  result: ExecuteResult
): void => {
  if (result.status === "paused") {
    const [first] = result.pending;

    const run: NonNullable<McpWideEvent["run"]> = {
      executionId: result.executionId,
      status: "paused",
      toolCalls: result.pending.length,
    };

    if (first) {
      run.pausedOn = `${first.connector}.${first.method}`;
    }

    log.set({ run });

    return;
  }

  log.set({
    run: {
      executionId: "",
      status: result.status,
      toolCalls: result.calls.length,
    },
  });
};

export const recordApprovalDecision = <TConsumer extends object>(
  log: McpRequestLogger<TConsumer>,
  event: {
    approverOpaque: string;
    decision: "approve" | "reject";
    executionId: string;
    source?: "approval_page" | "mcp_app";
  }
): void => {
  log.set({
    approval: {
      actor: event.approverOpaque,
      approverOpaque: event.approverOpaque,
      decision: event.decision,
      executionId: event.executionId,
      outcome: event.decision === "approve" ? "approved" : "denied",
      source: event.source ?? "approval_page",
    },
  });
};

// A receipt never carries field values on the wide event, only the counts a
// dashboard needs: how many operations landed, were no-ops, failed, hit a
// conflict, or landed with a WordPress-normalised value.
export const recordWriteReceipt = <TConsumer extends object>(
  log: McpRequestLogger<TConsumer>,
  receipt: BatchReceipt
): void => {
  const count = (status: OperationReceipt["status"]): number =>
    receipt.operations.filter((operation) => operation.status === status)
      .length;

  const normalized = receipt.operations.filter(
    (operation) => operation.normalized_paths.length > 0
  ).length;

  const targets = receipt.operations.map((operation) =>
    boundedTarget(operation.target)
  );

  const target = targets[0] ?? "unknown";
  const context = log.getContext();
  const parsedActor = wordpressActorSchema.safeParse(context.wordpress?.actor);
  const wordpressActor = parsedActor.success ? parsedActor.data : undefined;
  const { approval } = context;

  if (approval) {
    const actor = wordpressActor?.slug ?? approval.actor;

    const approvalEvent: NonNullable<McpWideEvent["approval"]> = {
      outcome: approval.outcome ?? "approved",
      targets,
    };

    if (actor) {
      approvalEvent.actor = actor;
    }

    if (wordpressActor) {
      approvalEvent.wordpressActor = wordpressActor;
    }

    if (approval.approverOpaque) {
      approvalEvent.approverOpaque = approval.approverOpaque;
    }

    if (approval.decision) {
      approvalEvent.decision = approval.decision;
    }

    if (approval.executionId) {
      approvalEvent.executionId = approval.executionId;
    }

    if (approval.source) {
      approvalEvent.source = approval.source;
    }

    log.set({ approval: approvalEvent });
  }

  log.set({
    write: {
      action: "wp.apply",
      changed: count("changed"),
      conflict: count("conflict"),
      failed: count("failed"),
      normalized,
      outcome: receipt.status === "succeeded" ? "success" : "error",
      target,
      targets,
      unchanged: count("unchanged"),
    },
  });

  const auditActor = wordpressActor
    ? {
        displayName: wordpressActor.slug,
        id: receipt.approverOpaque,
        type: "user" as const,
      }
    : { id: receipt.approverOpaque, type: "user" as const };

  log.audit({
    action: "wp.apply",
    actor: auditActor,
    correlationId: receipt.executionId,
    outcome: receipt.status === "succeeded" ? "success" : "failure",
    target: {
      id: target,
      targets,
      type: "wordpress",
    },
  });
};

const isStreamingResponse = (response: Response): boolean => {
  if (!response.body) {
    return false;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  return (
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson") ||
    response.headers.has("x-vercel-ai-ui-message-stream") ||
    response.headers
      .get("transfer-encoding")
      ?.toLowerCase()
      .includes("chunked") === true
  );
};

const setResponseFields = <TConsumer extends object>(
  response: Response,
  log: McpRequestLogger<TConsumer>
): void => {
  log.set({
    http: {
      outcome: httpOutcome(response.status),
      status: response.status,
      stream: {
        outcome: isStreamingResponse(response) ? "pending" : "not_streamed",
      },
    },
  });
};

const monitorResponseStream = <TConsumer extends object>(
  response: Response,
  log: McpRequestLogger<TConsumer>
): Response => {
  if (!isStreamingResponse(response) || !response.body) {
    return response;
  }

  if (response.body.locked) {
    log.setLevel("error");
    log.set({ http: { stream: { outcome: "errored" } } });

    return response;
  }

  const reader = response.body.getReader();
  let settled = false;

  const settle = (outcome: StreamOutcome): void => {
    if (settled) {
      return;
    }

    settled = true;
    log.set({ http: { stream: { outcome } } });
  };

  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      settle("cancelled");

      try {
        await reader.cancel(reason);
      } catch {
        log.set({ http: { stream: { outcome: "errored" } } });
        throw new Error("Response stream cancellation failed");
      }
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          settle("completed");
          controller.close();

          return;
        }

        controller.enqueue(chunk.value);
      } catch {
        settle("errored");
        controller.error(new Error("Response stream failed"));
      }
    },
  });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export const withMcpRequestLog = <
  TConsumer extends object = Record<never, never>,
>(
  handler: McpRequestHandler<TConsumer>,
  options: McpLoggingOptions = {}
) => {
  const evlogOptions: EvlogWorkersOptions = { redact: REDACTION };

  if (options.drain) {
    evlogOptions.drain = options.drain;
  }

  return withEvlog<Env>(async (request, env, ctx, logger) => {
    const untypedLogger: unknown = logger;
    // SAFETY: Evlog creates this request logger without runtime field metadata;
    // this wrapper owns every base field and the consumer type exists only at compile time.
    const log = untypedLogger as McpRequestLogger<TConsumer>;
    log.set({
      authentication: {
        actor: "unknown",
        outcome: "pending",
      },
      deployment: {
        environment: env.DEPLOYMENT_ENVIRONMENT,
      },
      http: {
        outcome: "server_error",
        status: 500,
        stream: { outcome: "not_started" },
      },
      mcp: {
        outcome: "pending",
        transport: "streamable-http",
      },
    });

    try {
      const response = await handler(request, env, ctx, log);
      setResponseFields(response, log);

      return monitorResponseStream(response, log);
    } catch {
      log.set({
        http: {
          outcome: "server_error",
          status: 500,
          stream: { outcome: "not_started" },
        },
        mcp: { outcome: "error" },
      });
      throw new Error("Unhandled request failure");
    }
  }, evlogOptions);
};

export const opaqueSubject = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hex.slice(0, 16);
};

export const boundedPath = (input: string | URL): string => {
  try {
    const url =
      input instanceof URL
        ? input
        : new URL(input, "https://wordpress.example");

    const path = url.pathname || "/";

    return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
  } catch {
    return "/";
  }
};
