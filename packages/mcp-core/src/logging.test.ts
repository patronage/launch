import { createLogger } from "evlog";
import { describe, expect, it, vi } from "vitest";

import {
  boundedPath,
  opaqueSubject,
  recordApprovalDecision,
  recordConsumerWrite,
  recordPluginDownload,
  recordRun,
  recordUpstreamRequests,
  recordWriteReceipt,
  withMcpRequestLog,
} from "./logging";
import type { McpRequestLogger, McpWideEvent } from "./logging";
import { testGatewayEnv } from "./test-env";

const env = testGatewayEnv();

const requestLogger = (): McpRequestLogger => {
  const log = createLogger<McpWideEvent>();

  // SAFETY: Evlog's generic logger includes the audit and context methods used by McpRequestLogger.
  return log as McpRequestLogger;
};

describe(withMcpRequestLog, () => {
  it("emits one redacted wide event with accumulated consumer fields", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog<{
      label: string;
      token: string;
    }>(
      (_request, _env, _ctx, log) => {
        log.set({
          authentication: {
            actor: "0123456789abcdef",
            outcome: "allowed",
          },
        });
        log.set({
          consumer: {
            label: "retained",
            token: "must-not-be-logged",
          },
        });

        return new Response("ok", { status: 200 });
      },
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    const response = await worker.fetch(
      new Request("https://launch-mcp.example.com/mcp"),
      env,
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      authentication: {
        actor: "0123456789abcdef",
        outcome: "allowed",
      },
      consumer: {
        label: "retained",
        token: "[REDACTED]",
      },
      deployment: { environment: "test" },
      http: {
        status: 200,
        stream: { outcome: "not_streamed" },
      },
      mcp: { transport: "streamable-http" },
    });
  });

  it("emits the final event when a response stream completes", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("data: complete\n\n")
              );
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        ),
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    const response = await worker.fetch(
      new Request("https://launch-mcp.example.com/mcp"),
      env,
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    expect(events).toHaveLength(0);

    await expect(response.text()).resolves.toBe("data: complete\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      http: { status: 200, stream: { outcome: "completed" } },
    });
  });

  it("emits the final event once when a response stream is cancelled", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog(
      () =>
        new Response(new ReadableStream(), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    const response = await worker.fetch(
      new Request("https://launch-mcp.example.com/mcp"),
      env,
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    await response.body?.cancel("client disconnected");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      http: { status: 200, stream: { outcome: "cancelled" } },
    });
  });

  it("emits a redacted final event once when a response stream errors", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(
                new Error("source-token-must-not-appear@example.com")
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        ),
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    const response = await worker.fetch(
      new Request("https://launch-mcp.example.com/mcp"),
      env,
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    await expect(response.text()).rejects.toThrow("Response stream failed");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      http: { status: 200, stream: { outcome: "errored" } },
      level: "error",
    });
    expect(JSON.stringify(events[0])).not.toContain("source-token");
  });

  it("records reusable plugin download and approved write metadata", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog(
      (_request, _env, _ctx, log) => {
        recordPluginDownload(log, {
          durationMs: 12,
          outcome: "success",
          package: "example-plugin",
          version: "1.2.3",
        });
        recordConsumerWrite(log, {
          approval: {
            actor: "0123456789abcdef",
            outcome: "approved",
            source: "user_confirmation",
          },
          write: {
            action: "post.update",
            durationMs: 18,
            outcome: "success",
            target: "/wp-json/wp/v2/posts/7?context=edit",
          },
        });

        return new Response(null, { status: 204 });
      },
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    await worker.fetch(
      new Request("https://launch-mcp.example.com/plugin.zip"),
      env,
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    expect(events[0]).toMatchObject({
      approval: {
        actor: "0123456789abcdef",
        outcome: "approved",
        source: "user_confirmation",
      },
      audit: {
        action: "post.update",
        actor: { id: "0123456789abcdef", type: "user" },
        outcome: "success",
        target: { id: "/wp-json/wp/v2/posts/7", type: "wordpress" },
      },
      plugin: {
        download: {
          durationMs: 12,
          outcome: "success",
          package: "example-plugin",
          version: "1.2.3",
        },
      },
      write: {
        action: "post.update",
        durationMs: 18,
        outcome: "success",
        target: "/wp-json/wp/v2/posts/7",
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("context=edit");
  });

  it("emits one final event for an unhandled failure", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog(
      () => {
        throw new Error("private-failure-detail");
      },
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    await expect(
      worker.fetch(new Request("https://launch-mcp.example.com/mcp"), env, {
        waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
      })
    ).rejects.toThrow("Unhandled request failure");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      http: {
        outcome: "server_error",
        status: 500,
        stream: { outcome: "not_started" },
      },
      level: "error",
      mcp: { outcome: "error" },
    });
    expect(JSON.stringify(events[0])).not.toContain("private-failure-detail");
  });
});

describe(boundedPath, () => {
  it("strips query strings and credentials", () => {
    expect(
      boundedPath(
        "https://user:pass@wordpress.example/wp-json/wp/v2/users/me?context=edit"
      )
    ).toBe("/wp-json/wp/v2/users/me");
  });
});

describe(opaqueSubject, () => {
  it("returns a stable hex prefix, not the input", async () => {
    const value = await opaqueSubject("access-subject-placeholder");
    expect(value).toMatch(/^[a-f0-9]{16}$/u);
    expect(value).not.toContain("access-subject");
    await expect(opaqueSubject("access-subject-placeholder")).resolves.toBe(
      value
    );
  });
});

describe("code-mode wide-event fields", () => {
  it("records a paused run with its connector call count and pause target", () => {
    const log = requestLogger();
    recordRun(log, {
      executionId: "exec_1",
      pending: [
        {
          connector: "wp",
          intent: "Fix the headline",
          method: "apply",
          sentences: ["Update title on pages 42"],
          seq: 3,
        },
      ],
      status: "paused",
      summary: "Paused for approval: Fix the headline (1 operation).",
    });
    expect(log.getContext().run).toStrictEqual({
      executionId: "exec_1",
      pausedOn: "wp.apply",
      status: "paused",
      toolCalls: 1,
    });
  });

  it("records a completed run without an execution id", () => {
    const log = requestLogger();
    recordRun(log, {
      calls: [
        { connector: "wp", method: "graphql", seq: 1, state: "applied" },
        { connector: "wp", method: "get", seq: 2, state: "applied" },
      ],
      result: null,
      status: "complete",
    });
    expect(log.getContext().run).toStrictEqual({
      executionId: "",
      status: "complete",
      toolCalls: 2,
    });
  });

  it("records the approval decision with an opaque approver", () => {
    const log = requestLogger();
    recordApprovalDecision(log, {
      approverOpaque: "approver00000000",
      decision: "approve",
      executionId: "exec_1",
    });
    expect(log.getContext().approval).toMatchObject({
      approverOpaque: "approver00000000",
      decision: "approve",
      executionId: "exec_1",
      outcome: "approved",
    });
  });

  it("records receipt counts and never the operation payloads", () => {
    const log = requestLogger();
    recordApprovalDecision(log, {
      approverOpaque: "approver00000000",
      decision: "approve",
      executionId: "exec_1",
    });
    recordUpstreamRequests(log, {
      actor: { id: 42, slug: "editor" },
      auth: "access-jwt",
      requests: [],
      target: "wordpress.example",
    });
    recordWriteReceipt(log, {
      approverOpaque: "approver00000000",
      executionId: "exec_1",
      operations: [
        {
          changed_paths: ["title"],
          kind: "update_post",
          normalized_paths: ["title"],
          operation_index: 0,
          status: "changed",
          target: "pages/42",
        },
        {
          changed_paths: [],
          kind: "update_post",
          normalized_paths: [],
          operation_index: 1,
          status: "conflict",
          target: "pages/9",
        },
      ],
      requesterOpaque: "requester0000000",
      status: "partial",
    });
    expect(log.getContext().write).toMatchObject({
      action: "wp.apply",
      changed: 1,
      conflict: 1,
      failed: 0,
      normalized: 1,
      outcome: "error",
      target: "pages/42",
      targets: ["pages/42", "pages/9"],
      unchanged: 0,
    });
    expect(log.getContext()).toMatchObject({
      approval: {
        actor: "editor",
        approverOpaque: "approver00000000",
        decision: "approve",
        executionId: "exec_1",
        targets: ["pages/42", "pages/9"],
        wordpressActor: { id: 42, slug: "editor" },
      },
      audit: {
        actor: {
          displayName: "editor",
          id: "approver00000000",
          type: "user",
        },
        correlationId: "exec_1",
        target: {
          id: "pages/42",
          targets: ["pages/42", "pages/9"],
          type: "wordpress",
        },
      },
    });
    expect(JSON.stringify(log.getContext())).not.toContain("title");
  });
});
