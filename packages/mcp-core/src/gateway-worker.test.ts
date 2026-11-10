import { generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BatchReceipt } from "./apply";
import type { CallerContext } from "./caller";
import { delay } from "./concurrency";
import type { GatewayConnector } from "./gateway-connector";
import { createWorker } from "./index";
import type { UpstreamRequestLog } from "./logging";
import type { RunReport } from "./run";
import { fakeBinding, testGatewayEnv } from "./test-env";

// The worker reads only whether a connector is configured and its paragraph
// of the `execute` description; the runtime is stubbed in these tests.
const fakeConnector: GatewayConnector = {
  configured: () => true,
  executeDescription: "Read with wp.get({ path }).",
  instructions: "",
  name: "wp",
  parseApply: () => ({ intent: "", sentences: [] }),
  preflight: () => Promise.reject(new Error("not used")),
  tools: () => ({}),
};

interface RuntimeCall {
  caller?: CallerContext | undefined;
  method: string;
  previewDigest?: string | undefined;
}

type StubReport = Omit<RunReport, "executionId">;

const UNKNOWN_RUN: StubReport = { calls: [], status: "unknown" };

const PAUSED_RUN: StubReport = {
  calls: [],
  preflight: {
    intent: "Fix the launch headline",
    operations: [
      {
        editUrl:
          "https://wordpress.example/wp-admin/post.php?post=42&action=edit",
        fields: [
          {
            after: "New title",
            before: "Old title",
            changed: true,
            path: "title",
          },
        ],
        modifiedGmt: "2026-09-01T10:00:00",
        operationIndex: 0,
        sentence: "Update title on pages 42",
        slug: "launch",
        target: "pages/42",
      },
    ],
  },
  status: "paused",
};

const APPROVED_RECEIPT: BatchReceipt = {
  approverOpaque: "approver00000000",
  executionId: "exec_1",
  operations: [
    {
      changed_paths: ["title"],
      kind: "update_post",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "pages/42",
    },
  ],
  requesterOpaque: "requester0000000",
  status: "succeeded",
};

// What a run reports for display: the LATEST wp.apply, which names a
// different post here so an assertion on the wide event says which of the two
// receipts the decision actually recorded.
const LATEST_RECEIPT: BatchReceipt = {
  approverOpaque: "approver00000000",
  executionId: "exec_1",
  operations: [
    {
      changed_paths: ["title"],
      kind: "update_post",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "posts/900",
    },
  ],
  requesterOpaque: "requester0000000",
  status: "succeeded",
};

const APPLIED_RUN: StubReport = {
  calls: [],
  receipt: APPROVED_RECEIPT,
  status: "complete",
};

// What `approve` answers with: the report also names the receipt of the write
// this decision authorised, which is the only thing the decision records.
const APPROVED_RUN: StubReport = {
  approvedReceipt: APPROVED_RECEIPT,
  calls: [],
  receipt: APPROVED_RECEIPT,
  status: "complete",
};

const REJECTED_RUN: StubReport = {
  calls: [],
  error: "The approval was rejected",
  status: "error",
};

const WORDPRESS_REQUESTS: UpstreamRequestLog = {
  actor: { id: 42, slug: "editor" },
  auth: "access-jwt",
  requests: [
    {
      durationMs: 9,
      method: "GET",
      outcome: "success",
      path: "/wp-json/wp/v2/pages/42",
      status: 200,
    },
  ],
  target: "wordpress.example",
};

const runtimeCalls: RuntimeCall[] = [];
const instanceNames: string[] = [];
let stubsObtained = 0;

// What the Durable Object answers for this test, set per case.
const runReports = {
  approve: APPROVED_RUN,
  getRun: UNKNOWN_RUN,
  reject: REJECTED_RUN,
};

// Set to hold an approval open, as a slow write would.
let approveGate: Promise<void> | undefined;

const runtime = {
  approve: (
    executionId: string,
    caller: CallerContext,
    previewDigest?: string
  ) => {
    runtimeCalls.push({ caller, method: "approve", previewDigest });

    return (approveGate ?? Promise.resolve()).then(() => ({
      upstream: WORDPRESS_REQUESTS,
      value: { ...runReports.approve, executionId },
    }));
  },
  describeSite: (caller: CallerContext) => {
    runtimeCalls.push({ caller, method: "describeSite" });

    return Promise.resolve({
      upstream: WORDPRESS_REQUESTS,
      value: [
        {
          connector: "wp",
          description: {
            acfTypes: [],
            contentTypes: [],
            postTypes: [],
            site: { name: "Example Site", url: "https://wordpress.example" },
          },
        },
      ],
    });
  },
  execute: (
    _code: string,
    _intent: string | undefined,
    caller: CallerContext
  ) => {
    runtimeCalls.push({ caller, method: "execute" });

    return Promise.resolve({
      upstream: WORDPRESS_REQUESTS,
      value: { calls: [], result: { ok: true }, status: "complete" },
    });
  },
  getRun: (executionId: string, caller?: CallerContext) => {
    runtimeCalls.push({ caller, method: "getRun" });

    return Promise.resolve({
      upstream: WORDPRESS_REQUESTS,
      value: { ...runReports.getRun, executionId },
    });
  },
  reject: (
    executionId: string,
    caller: CallerContext,
    previewDigest?: string
  ) => {
    runtimeCalls.push({ caller, method: "reject", previewDigest });

    return Promise.resolve({
      upstream: WORDPRESS_REQUESTS,
      value: { ...runReports.reject, executionId },
    });
  },
  verifyNonce: (_executionId: string, approvalToken: string) => {
    runtimeCalls.push({ method: "verifyNonce" });

    return Promise.resolve(approvalToken === "good-token");
  },
};

// The worker calls only `idFromName` and `get` on the namespace, and only the
// RPC methods `runtime` stubs on the object `get` returns.
const runtimeNamespace = fakeBinding<DurableObjectNamespace>({
  get: () => {
    stubsObtained += 1;

    return runtime;
  },
  idFromName: (name: string) => {
    instanceNames.push(name);

    return name;
  },
});

const env = testGatewayEnv({
  APPROVAL_CARD_FOR_UNKNOWN_CLIENTS: "false",
  APPROVAL_CSRF_SECRET: "csrf-secret",
  GATEWAY_RUNTIME: runtimeNamespace,
  MCP_ALLOWED_HOSTNAMES: "launch-mcp.example.com",
});

const APPROVAL_ORIGIN = "https://launch-mcp.example.com";

const accessIdentity = async (
  claims: JWTPayload = {}
): Promise<{ publicKey: CryptoKey; token: string }> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");

  const token = await new SignJWT({
    email: "editor@example.com",
    sub: "end-to-end-subject",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "end-to-end-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(env.ACCESS_TEAM_DOMAIN)
    .setAudience(env.ACCESS_AUD)
    .sign(privateKey);

  return { publicKey, token };
};

const toolRequest = (url: string, token?: string): Request => {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Host: new URL(url).host,
  });

  if (token) {
    headers.set("Cf-Access-Jwt-Assertion", token);
  }

  return new Request(url, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "describe_site" },
    }),
    headers,
    method: "POST",
  });
};

const approvalRequest = (
  executionId: string,
  token: string,
  method = "GET"
): Request =>
  new Request(`${APPROVAL_ORIGIN}/mcp/approvals/${executionId}`, {
    headers: { "Cf-Access-Jwt-Assertion": token },
    method,
  });

const approvalDecision = (
  executionId: string,
  token: string,
  fields: Record<string, string>
): Request =>
  new Request(`${APPROVAL_ORIGIN}/mcp/approvals/${executionId}`, {
    body: new URLSearchParams(fields),
    headers: { "Cf-Access-Jwt-Assertion": token },
    method: "POST",
  });

// The fields a browser would post back: the page is the only place they exist.
const hiddenField = (html: string, name: string): string =>
  new RegExp(
    `name="${name}" type="hidden" value="(?<value>[a-f0-9]*)"`,
    "u"
  ).exec(html)?.groups?.value ?? "";

const executionContext = () => ({
  waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
});

const collectingWorker = (publicKey: CryptoKey, events: unknown[]) =>
  createWorker({
    accessKey: () => publicKey,
    connectors: [fakeConnector],
    drain: ({ event }) => {
      events.push(event);
    },
  });

const openApproval = async (executionId = "exec_1") => {
  const events: unknown[] = [];
  const { publicKey, token } = await accessIdentity();
  const worker = collectingWorker(publicKey, events);

  const response = await worker.fetch(
    approvalRequest(executionId, token),
    env,
    executionContext()
  );

  const html = await response.text();

  return {
    csrf: hiddenField(html, "csrf"),
    events,
    html,
    preview: hiddenField(html, "preview"),
    response,
    token,
    worker,
  };
};

// What a client says it can render, in the one shape this Worker reads.
interface ClientCapabilitiesPayload {
  extensions?: Record<string, Record<string, never>>;
}

interface ListToolsParams {
  _meta?: Record<string, ClientCapabilitiesPayload>;
}

// `tools/list` carrying the per-request client-capabilities envelope of
// protocol revision 2026-07-28, which is the only place a stateless
// deployment can read what the client renders.
const listToolsRequest = (
  token: string,
  capabilities?: ClientCapabilitiesPayload
): Request => {
  const params: ListToolsParams = capabilities
    ? { _meta: { "io.modelcontextprotocol/clientCapabilities": capabilities } }
    : {};

  return new Request("http://localhost:8787/mcp", {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params,
    }),
    headers: new Headers({
      Accept: "application/json, text/event-stream",
      "Cf-Access-Jwt-Assertion": token,
      "Content-Type": "application/json",
      Host: "localhost:8787",
    }),
    method: "POST",
  });
};

const listToolNames = async (
  capabilities?: ClientCapabilitiesPayload,
  cardForUnknownClients = false
): Promise<string> => {
  const { publicKey, token } = await accessIdentity();
  const worker = collectingWorker(publicKey, []);

  const response = await worker.fetch(
    listToolsRequest(token, capabilities),
    {
      ...env,
      APPROVAL_CARD_FOR_UNKNOWN_CLIENTS: cardForUnknownClients
        ? "true"
        : "false",
    },
    executionContext()
  );

  return await response.text();
};

// One JSON-RPC message or batch to /mcp, signed in, with no client
// capabilities stated anywhere.
interface JsonRpcMessage {
  id?: number;
  jsonrpc: "2.0";
  method: string;
  params?: {
    arguments?: Record<string, string>;
    capabilities?: Record<string, never>;
    clientInfo?: { name: string; version: string };
    name?: string;
    protocolVersion?: string;
    uri?: string;
  };
}

const sendRpc = async (message: JsonRpcMessage | JsonRpcMessage[]) => {
  const events: unknown[] = [];
  const { publicKey, token } = await accessIdentity();
  const worker = collectingWorker(publicKey, events);

  const response = await worker.fetch(
    new Request("http://localhost:8787/mcp", {
      body: JSON.stringify(message),
      headers: new Headers({
        Accept: "application/json, text/event-stream",
        "Cf-Access-Jwt-Assertion": token,
        "Content-Type": "application/json",
        Host: "localhost:8787",
      }),
      method: "POST",
    }),
    env,
    executionContext()
  );

  return { body: await response.text(), events, response };
};

const resetRuntime = (): void => {
  runtimeCalls.length = 0;
  instanceNames.length = 0;
  stubsObtained = 0;
  runReports.approve = APPROVED_RUN;
  approveGate = undefined;
  runReports.getRun = UNKNOWN_RUN;
  runReports.reject = REJECTED_RUN;
};

describe("Worker fetch", () => {
  beforeEach(resetRuntime);

  it("emits one event for a successful code-mode tool call", async () => {
    const events: unknown[] = [];
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, events);

    const response = await worker.fetch(
      toolRequest("http://localhost:8787/mcp", token),
      env,
      executionContext()
    );

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Example Site");
    expect(runtimeCalls.at(-1)?.method).toBe("describeSite");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      authentication: {
        actor: expect.stringMatching(/^[a-f0-9]{16}$/u),
        outcome: "allowed",
      },
      http: { status: 200 },
      mcp: {
        durationMs: expect.any(Number),
        outcome: "success",
        tool: "describe_site",
        transport: "streamable-http",
      },
    });
  });

  it("obtains the one runtime instance from the namespace on every request", async () => {
    const { publicKey, token } = await accessIdentity();
    const events: unknown[] = [];
    const worker = collectingWorker(publicKey, events);

    const first = await worker.fetch(
      toolRequest("http://localhost:8787/mcp", token),
      env,
      executionContext()
    );

    await first.text();

    const second = await worker.fetch(
      toolRequest("http://localhost:8787/mcp", token),
      env,
      executionContext()
    );

    await second.text();

    expect(instanceNames).toStrictEqual(["site", "site"]);
    expect(stubsObtained).toBe(2);
    expect(events).toHaveLength(2);
  });

  it("hands the verified caller to the runtime without logging it", async () => {
    const events: unknown[] = [];

    const { publicKey, token } = await accessIdentity({
      email: "user@example.com",
    });

    const worker = collectingWorker(publicKey, events);

    const response = await worker.fetch(
      toolRequest("https://launch-mcp.example.com/mcp", token),
      env,
      executionContext()
    );

    await response.text();

    expect(runtimeCalls).toStrictEqual([
      {
        caller: {
          subjectOpaque: expect.stringMatching(/^[a-f0-9]{16}$/u),
          token,
        },
        method: "describeSite",
      },
    ]);
    const serializedEvent = JSON.stringify(events[0]);
    expect({
      containsEmail: serializedEvent.includes("user@example.com"),
      containsToken: serializedEvent.includes(token),
      eventCount: events.length,
    }).toStrictEqual({
      containsEmail: false,
      containsToken: false,
      eventCount: 1,
    });
  });

  it("rejects an MCP hostname that the deployment did not configure", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);

    const response = await worker.fetch(
      toolRequest("https://unconfigured.example/mcp", token),
      env,
      executionContext()
    );

    await response.text();

    expect(response.status).toBe(403);
    expect(runtimeCalls).toHaveLength(0);
  });

  it("refuses a browser request from an Origin the deployment does not serve", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);
    const request = toolRequest("https://launch-mcp.example.com/mcp", token);
    request.headers.set("Origin", "https://elsewhere.example");

    const response = await worker.fetch(request, env, executionContext());
    await response.text();

    expect(response.status).toBe(403);
    expect(runtimeCalls).toHaveLength(0);
  });

  it("accepts a browser request from the deployment's own Origin", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);
    const request = toolRequest("https://launch-mcp.example.com/mcp", token);
    request.headers.set("Origin", "https://launch-mcp.example.com");

    const response = await worker.fetch(request, env, executionContext());
    await response.text();

    expect(response.status).toBe(200);
  });

  it("challenges a request without an Access assertion", async () => {
    const events: unknown[] = [];

    const worker = createWorker({
      connectors: [fakeConnector],
      drain: ({ event }) => {
        events.push(event);
      },
    });

    const response = await worker.fetch(
      toolRequest("https://launch-mcp.example.com/mcp"),
      env,
      executionContext()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("X-Access-Reason")).toBe("missing_token");
    expect(runtimeCalls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      authentication: {
        actor: "unknown",
        outcome: "challenged",
        reason: "missing_token",
      },
    });
  });

  it("offers the app-only tools to a client that advertises the UI extension", async () => {
    const body = await listToolNames({
      extensions: { "io.modelcontextprotocol/ui": {} },
    });

    expect(body).toContain("decide_write");
    expect(body).toContain("preview_write");
  });

  it("hides the app-only tools from a client that advertises without it", async () => {
    const body = await listToolNames({ extensions: { "vendor/other": {} } });

    expect(body).toContain("execute");
    expect(body).not.toContain("decide_write");
    expect(body).not.toContain("preview_write");
  });

  it("hides the app-only tools from a client that advertises no extension", async () => {
    const body = await listToolNames({});

    expect(body).toContain("execute");
    expect(body).not.toContain("decide_write");
  });

  // A client that never advertised MCP Apps has promised nothing about
  // tool-result `_meta`, so it must not be handed the approval token.
  it("hides the app-only tools from a client that states no capabilities", async () => {
    const body = await listToolNames();

    expect(body).toContain("execute");
    expect(body).not.toContain("decide_write");
    expect(body).not.toContain("preview_write");
  });

  it("offers the card to unreadable clients only when the var says so", async () => {
    const body = await listToolNames(undefined, true);

    expect(body).toContain("decide_write");
    expect(body).toContain("preview_write");
  });

  it("answers a path outside /mcp with 404 before Access and logs no MCP fields", async () => {
    const events: unknown[] = [];
    const { publicKey } = await accessIdentity();
    const worker = collectingWorker(publicKey, events);

    const response = await worker.fetch(
      new Request("https://launch-mcp.example.com/smtp/.env", {
        headers: { Host: "launch-mcp.example.com" },
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(404);
    expect(runtimeCalls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      authentication: { outcome: "pending" },
      http: { status: 404, stream: { outcome: "not_streamed" } },
    });
    expect(events[0]).not.toHaveProperty("mcp");
  });

  it("logs the Worker's own name as the event's service", async () => {
    const events: unknown[] = [];
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, events);

    const response = await worker.fetch(
      toolRequest("http://localhost:8787/mcp", token),
      { ...env, WORKER_NAME: "site-mcp" },
      executionContext()
    );

    await response.text();

    expect(events[0]).toMatchObject({ service: "site-mcp" });
  });

  it("logs a challenged request as challenged, not as an MCP error", async () => {
    const events: unknown[] = [];
    const { publicKey } = await accessIdentity();
    const worker = collectingWorker(publicKey, events);

    await worker.fetch(
      toolRequest("https://launch-mcp.example.com/mcp"),
      env,
      executionContext()
    );

    expect(events[0]).toMatchObject({ mcp: { outcome: "challenged" } });
    expect(events[0]).not.toHaveProperty("mcp.transport");
  });

  it("logs a denied request as denied, not as an MCP error", async () => {
    const events: unknown[] = [];
    const { publicKey } = await accessIdentity();
    const worker = collectingWorker(publicKey, events);

    await worker.fetch(
      toolRequest("https://launch-mcp.example.com/mcp", "not-a-jwt"),
      env,
      executionContext()
    );

    expect(events[0]).toMatchObject({
      authentication: { outcome: "denied" },
      mcp: { outcome: "denied" },
    });
  });

  it.each([
    [
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
        protocolVersion: "2025-06-18",
      },
    ],
    ["tools/list", {}],
  ])("logs the JSON-RPC method of %s", async (method, params) => {
    const { events } = await sendRpc({ id: 1, jsonrpc: "2.0", method, params });

    expect(events[0]).toMatchObject({
      mcp: { method, transport: "streamable-http" },
    });
  });

  it("logs the resource a resources/read asked for", async () => {
    const { events } = await sendRpc({
      id: 1,
      jsonrpc: "2.0",
      method: "resources/read",
      params: {
        uri: "ui://patronage/wordpress-approval-v3.html?token=secret#frag",
      },
    });

    expect(events[0]).toMatchObject({
      mcp: {
        method: "resources/read",
        resource: "ui://patronage/wordpress-approval-v3.html",
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("secret");
  });

  it("logs every method of a JSON-RPC batch", async () => {
    const { events } = await sendRpc([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    ]);

    expect(events[0]).toMatchObject({
      mcp: {
        method: "notifications/initialized",
        methods: ["notifications/initialized", "tools/list"],
      },
    });
  });

  // A host may forward the card's own call without the capabilities `_meta`
  // it sent on `execute`. The card was already offered, so the tool answers.
  it("serves the card's preview tool on a tools/call that states no capabilities", async () => {
    const { body } = await sendRpc({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { approvalToken: "bad-token", executionId: "exec_1" },
        name: "preview_wordpress_write",
      },
    });

    expect(body).not.toMatch(/not found/iu);
    expect(body).toContain("invalid_approval_token");
    expect(runtimeCalls.map((call) => call.method)).toStrictEqual([
      "verifyNonce",
    ]);
  });

  it("still hides the card's tools from tools/list without capabilities", async () => {
    const { body } = await sendRpc({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });

    expect(body).not.toContain("preview_wordpress_write");
  });
});

describe("Approval route", () => {
  beforeEach(resetRuntime);

  it("renders the approval page for a paused run", async () => {
    runReports.getRun = PAUSED_RUN;

    const { csrf, html, response } = await openApproval();

    expect(response.status).toBe(200);
    expect(html).toContain("Update title on pages 42");
    expect(html).toContain('value="approve"');
    expect(csrf).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("sends the browser safety headers with the approval page", async () => {
    runReports.getRun = PAUSED_RUN;

    const { response } = await openApproval();

    expect(Object.fromEntries(response.headers)).toMatchObject({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });

  it("computes the preview as the verified caller", async () => {
    runReports.getRun = PAUSED_RUN;

    const { events } = await openApproval();

    // Without the caller the runtime reports the run and builds no preview.
    expect(runtimeCalls).toStrictEqual([
      {
        caller: {
          subjectOpaque: expect.stringMatching(/^[a-f0-9]{16}$/u),
          token: expect.any(String),
        },
        method: "getRun",
      },
    ]);
    expect(events[0]).toMatchObject({
      mcp: { outcome: "success", tool: "approval_page" },
    });
  });

  it("keeps the Access assertion off the page and out of the event", async () => {
    runReports.getRun = PAUSED_RUN;

    const { events, html, token } = await openApproval();

    expect(html).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("applies an approval and shows the receipt", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, token, worker } = await openApproval();

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { csrf, decision: "approve", preview }),
      env,
      executionContext()
    );

    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("succeeded");
    expect(html).toContain("pages/42");
    expect(html).toContain("approver00000000");
    expect(runtimeCalls.map((entry) => entry.method)).toStrictEqual([
      "getRun",
      "approve",
    ]);
  });

  it("records write receipt counts on the approval decision that produced them", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, events, token, worker } = await openApproval();

    // An approval streams its answer; the wide event is emitted once the
    // stream ends, so the body is read before the event is.
    const streamed = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf,
        decision: "approve",
        preview,
      }),
      env,
      executionContext()
    );

    await streamed.text();

    expect(events[1]).toMatchObject({
      write: {
        action: "wp.apply",
        changed: 1,
        conflict: 0,
        failed: 0,
        outcome: "success",
        target: "pages/42",
        unchanged: 0,
      },
    });
  });

  it("does not re-record the write receipt when a completed run's page is only reloaded", async () => {
    runReports.getRun = APPLIED_RUN;

    const { events, html, response } = await openApproval();

    expect(response.status).toBe(200);
    expect(html).toContain("succeeded");
    expect(events[0]).not.toHaveProperty("write");
  });

  it("records the runtime's WordPress requests on the approval GET event", async () => {
    runReports.getRun = PAUSED_RUN;

    const { events } = await openApproval();

    expect(events[0]).toMatchObject({ upstream: WORDPRESS_REQUESTS });
  });

  it("records the runtime's WordPress requests on the approval decision event", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, events, token, worker } = await openApproval();

    // An approval streams its answer; the wide event is emitted once the
    // stream ends, so the body is read before the event is.
    const streamed = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf,
        decision: "approve",
        preview,
      }),
      env,
      executionContext()
    );

    await streamed.text();

    expect(events[1]).toMatchObject({
      upstream: {
        auth: "access-jwt",
        requests: [{ path: "/wp-json/wp/v2/pages/42" }],
        target: "wordpress.example",
      },
    });
  });

  it("records a rejection and offers no further decision", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, token, worker } = await openApproval();

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { csrf, decision: "reject", preview }),
      env,
      executionContext()
    );

    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("The approval was rejected");
    expect(html).not.toContain("<form");
    expect(runtimeCalls.map((entry) => entry.method)).toStrictEqual([
      "getRun",
      "reject",
    ]);
  });

  it("re-renders the page when the approved run pauses again", async () => {
    runReports.getRun = PAUSED_RUN;
    runReports.approve = { calls: [], status: "paused" };
    const { csrf, preview, token, worker } = await openApproval();

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { csrf, decision: "approve", preview }),
      env,
      executionContext()
    );

    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("This run needs a further approval.");
    expect(html).toContain('value="approve"');
    // The second preview only exists if the page recomputes it.
    expect(runtimeCalls.map((entry) => entry.method)).toStrictEqual([
      "getRun",
      "approve",
      "getRun",
    ]);
  });

  it("records the write receipt when the approved run pauses again", async () => {
    runReports.getRun = PAUSED_RUN;
    // `approve` resolves only once the resumed run reaches its next stop, so
    // the run is already paused on its second `wp.apply` and the latest apply
    // in the log is that pending one: the report names no `receipt` at all.
    runReports.approve = {
      approvedReceipt: APPROVED_RECEIPT,
      calls: [],
      status: "paused",
    };
    const { csrf, preview, events, token, worker } = await openApproval();

    // An approval streams its answer; the wide event is emitted once the
    // stream ends, so the body is read before the event is.
    const streamed = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf,
        decision: "approve",
        preview,
      }),
      env,
      executionContext()
    );

    await streamed.text();

    expect(events[1]).toMatchObject({
      write: {
        action: "wp.apply",
        changed: 1,
        outcome: "success",
        target: "pages/42",
      },
    });
  });

  it("records the approved write once when the run completes", async () => {
    runReports.getRun = PAUSED_RUN;
    runReports.approve = {
      approvedReceipt: APPROVED_RECEIPT,
      calls: [],
      receipt: LATEST_RECEIPT,
      status: "complete",
    };
    const { csrf, preview, events, token, worker } = await openApproval();

    // An approval streams its answer; the wide event is emitted once the
    // stream ends, so the body is read before the event is.
    const streamed = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf,
        decision: "approve",
        preview,
      }),
      env,
      executionContext()
    );

    await streamed.text();

    // Two events: the GET that rendered the page and the decision. Only the
    // decision carries a write, and it names the post the approved receipt
    // wrote — recording the report's `receipt` as well would have overwritten
    // the target with the later write's.
    expect(events).toHaveLength(2);
    expect(events[0]).not.toHaveProperty("write");
    expect(events[1]).toMatchObject({
      approval: {
        actor: "editor",
        targets: ["pages/42"],
        upstreamActor: { id: 42, slug: "editor" },
      },
      audit: {
        action: "wp.apply",
        actor: {
          displayName: "editor",
          id: "approver00000000",
          type: "user",
        },
        correlationId: "exec_1",
        outcome: "success",
        target: {
          id: "pages/42",
          targets: ["pages/42"],
          type: "cms",
        },
      },
      write: {
        action: "wp.apply",
        changed: 1,
        failed: 0,
        outcome: "success",
        target: "pages/42",
        targets: ["pages/42"],
      },
    });
  });

  it("shows the runtime's reason when the run already ended in error", async () => {
    runReports.getRun = REJECTED_RUN;

    const { html, response } = await openApproval();

    expect(response.status).toBe(200);
    expect(html).toContain("The approval was rejected");
    expect(html).not.toContain("<button");
  });

  it("renders a problem page when an approved run kept no receipt", async () => {
    runReports.getRun = { calls: [], status: "complete" };

    const { html, response } = await openApproval();

    expect(response.status).toBe(200);
    expect(html).toContain("This run finished without a write receipt.");
  });

  it("offers no approval for a paused run whose preview has no operations", async () => {
    runReports.getRun = {
      calls: [],
      preflight: { intent: "unparsable wp.apply arguments", operations: [] },
      status: "paused",
    };

    const { html, response } = await openApproval();

    expect(response.status).toBe(200);
    expect(html).toContain("no_preview");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="reject"');
  });

  it("binds the decision to the preview the page showed", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, token, worker } = await openApproval();

    // An approval streams its answer; the wide event is emitted once the
    // stream ends, so the body is read before the event is.
    const streamed = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf,
        decision: "approve",
        preview,
      }),
      env,
      executionContext()
    );

    await streamed.text();

    expect(preview).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtimeCalls.at(-1)).toMatchObject({
      method: "approve",
      previewDigest: preview,
    });
  });

  it("refuses a form whose token was signed for another preview", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, token, worker } = await openApproval();

    const other = preview.startsWith("0")
      ? `1${preview.slice(1)}`
      : `0${preview.slice(1)}`;

    const response = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf,
        decision: "approve",
        preview: other,
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(403);
    expect(runtimeCalls.map((entry) => entry.method)).toStrictEqual(["getRun"]);
  });

  it("streams each operation as it settles, then the receipt", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, token, worker } = await openApproval();

    const held = new AbortController();
    approveGate = delay(60_000, held.signal);

    // While the approval is held open, the run reports one settled operation.
    runReports.getRun = {
      calls: [],
      progress: {
        approverOpaque: "approver00000000",
        executionId: "exec_1",
        operations: [
          {
            changed_paths: ["title"],
            kind: "update_post",
            normalized_paths: [],
            operation_index: 0,
            status: "changed",
            target: "pages/<42>",
          },
        ],
        requesterOpaque: "requester0000000",
        startedAt: 1,
        targets: ["pages/<42>", "pages/43"],
        total: 2,
        updatedAt: 2,
      },
      status: "running",
    };

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { csrf, decision: "approve", preview }),
      env,
      executionContext()
    );

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let streamed = "";

    // Read until the first progress line arrives, then let the write finish.
    while (!streamed.includes("</li>")) {
      // oxlint-disable-next-line no-await-in-loop -- reading one stream in order
      const chunk = await reader?.read();

      if (!chunk || chunk.done) {
        break;
      }

      streamed += decoder.decode(chunk.value);
    }

    expect(streamed).toContain("Applying the change");
    expect(streamed).toContain("1 of 2: <code>pages/&lt;42&gt;</code>");
    expect(streamed).not.toContain("Result:");

    held.abort();

    let rest = "";

    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- reading one stream in order
      const chunk = await reader?.read();

      if (!chunk || chunk.done) {
        break;
      }

      rest += decoder.decode(chunk.value);
    }

    expect(rest).toContain("Result: succeeded");
    expect(rest).toContain("</html>");
  });

  it("refuses a decision the runtime finds stale and decides nothing", async () => {
    runReports.getRun = PAUSED_RUN;
    runReports.approve = { ...PAUSED_RUN, stalePreview: true };
    const { csrf, preview, token, worker } = await openApproval();

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { csrf, decision: "approve", preview }),
      env,
      executionContext()
    );

    // The approval streams, so its status is sent before the runtime has
    // answered; the stale refusal arrives in the body instead of as a 409.
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("stale_approval");
  });

  it("refuses a POST whose CSRF token is forged", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);

    const response = await worker.fetch(
      approvalDecision("exec_1", token, {
        csrf: "forged",
        decision: "approve",
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(runtimeCalls).toHaveLength(0);
  });

  it("refuses a POST that carries no CSRF token", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { decision: "approve" }),
      env,
      executionContext()
    );

    expect(response.status).toBe(403);
    expect(runtimeCalls).toHaveLength(0);
  });

  it("refuses a decision that is neither approve nor reject", async () => {
    runReports.getRun = PAUSED_RUN;
    const { csrf, preview, token, worker } = await openApproval();

    const response = await worker.fetch(
      approvalDecision("exec_1", token, { csrf, decision: "delete", preview }),
      env,
      executionContext()
    );

    expect(response.status).toBe(400);
    expect(runtimeCalls.map((entry) => entry.method)).toStrictEqual(["getRun"]);
  });

  it("answers any other method with 405 and an Allow header", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);

    const response = await worker.fetch(
      approvalRequest("exec_1", token, "DELETE"),
      env,
      executionContext()
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
    // A caller-supplied header is added to the page, never over the mandatory
    // security headers.
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(runtimeCalls).toHaveLength(0);
  });

  it("answers an unknown execution id with 404", async () => {
    const { html, response } = await openApproval("exec_missing");

    expect(response.status).toBe(404);
    expect(html).toContain("Nothing to approve");
  });

  it("fails closed when no CSRF secret is configured", async () => {
    const { publicKey, token } = await accessIdentity();
    const worker = collectingWorker(publicKey, []);

    const response = await worker.fetch(
      approvalRequest("exec_1", token),
      { ...env, APPROVAL_CSRF_SECRET: "" },
      executionContext()
    );

    expect(response.status).toBe(500);
    expect(runtimeCalls).toHaveLength(0);
  });

  it("denies the approval route without an Access assertion", async () => {
    const events: unknown[] = [];

    const worker = createWorker({
      connectors: [fakeConnector],
      drain: ({ event }) => {
        events.push(event);
      },
    });

    const response = await worker.fetch(
      new Request(`${APPROVAL_ORIGIN}/mcp/approvals/exec_1`),
      env,
      executionContext()
    );

    expect(response.status).toBe(403);
    expect(runtimeCalls).toHaveLength(0);
  });
});
