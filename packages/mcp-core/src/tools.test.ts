import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createLogger } from "evlog";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  APPROVAL_APP_META_KEY,
  APPROVAL_APP_URI,
  LEGACY_APPROVAL_APP_URIS,
} from "./approval-app";
import type { CallerContext } from "./caller";
import type {
  McpRequestLogger,
  McpWideEvent,
  UpstreamRequestLog,
} from "./logging";
import type { ExecuteResult, RunReport, SiteDescription } from "./run";
import { registerTools } from "./tools";
import type { ClientAppSupport, RuntimeStub, ToolDeps } from "./tools";
import { UpstreamRequestError } from "./upstream";

// A connector's paragraph of the `execute` description, as a deployment adds it.
const FAKE_EXECUTE_DESCRIPTION =
  "Read with wp.get({ path }) and write with wp.apply({ intent, operations }).";

const caller: CallerContext = {
  subjectOpaque: "caller0000000000",
  token: "caller-token",
};

const wpDescription = {
  acfTypes: [],
  contentTypes: [],
  postTypes: [],
  site: { name: "Example", url: "https://wordpress.example" },
};

const siteDescription: SiteDescription = [
  { connector: "wp", description: wpDescription },
];

const pausedExecute: ExecuteResult = {
  executionId: "exec_1",
  pending: [
    {
      connector: "wp",
      intent: "Fix the headline",
      method: "apply",
      sentences: ["Update title on pages 42"],
      seq: 1,
    },
  ],
  status: "paused",
  summary: "Paused for approval: Fix the headline (1 operation).",
};

const pausedRun: RunReport = {
  calls: [],
  executionId: "exec_1",
  preflight: {
    intent: "Fix the headline",
    operations: [
      {
        editUrl:
          "https://wordpress.example/wp-admin/post.php?post=42&action=edit",
        fields: [
          {
            after: "A corrected headline.",
            before: "A corrected headline",
            changed: true,
            path: "title",
          },
        ],
        modifiedGmt: "2026-09-16T20:00:00",
        operationIndex: 0,
        sentence: "Update title on pages 42",
        slug: "launch",
        target: "pages/42",
      },
    ],
  },
  status: "paused",
};

const wordpress: UpstreamRequestLog = {
  auth: "access-jwt",
  requests: [
    {
      durationMs: 12,
      method: "POST",
      outcome: "success",
      path: "/graphql",
      status: 200,
    },
  ],
  target: "wordpress.example",
};

const requestLogger = (): McpRequestLogger => {
  const log = createLogger<McpWideEvent>();

  // SAFETY: Evlog's generic logger includes the audit and context methods used by McpRequestLogger.
  return log as McpRequestLogger;
};

interface ExecuteCall {
  caller: CallerContext;
  code: string;
  intent: string | undefined;
}

interface GetRunCall {
  caller: CallerContext | undefined;
  executionId: string;
}

interface StubCalls {
  approve: GetRunCall[];
  describeSite: CallerContext[];
  execute: ExecuteCall[];
  getRun: GetRunCall[];
  order: string[];
  reject: GetRunCall[];
}

interface StubOverrides {
  approve?: () => Promise<RunReport>;
  describeSite?: () => Promise<SiteDescription>;
  execute?: () => Promise<ExecuteResult>;
  getRun?: () => Promise<RunReport>;
  reject?: () => Promise<RunReport>;
}

// Every stubbed RPC answers with the value plus the same WordPress record, so
// each tool can be asked whether it put that record on the wide event.
const outcome = async <T>(value: Promise<T> | T) => ({
  value: await value,
  wordpress,
});

interface StubbedRuntime {
  calls: StubCalls;
  // The live token per run, so a test can prove single use and re-issue the
  // way the Durable Object's storage does.
  nonces: Map<string, string>;
  stub: RuntimeStub;
}

const stubRuntime = (overrides: StubOverrides = {}): StubbedRuntime => {
  const nonces = new Map<string, string>();
  let minted = 0;

  const calls: StubCalls = {
    approve: [],
    describeSite: [],
    execute: [],
    getRun: [],
    order: [],
    reject: [],
  };

  const stub: RuntimeStub = {
    approve: (executionId, context) => {
      calls.approve.push({ caller: context, executionId });
      calls.order.push("approve");

      return outcome(
        overrides.approve?.() ?? {
          approvedReceipt: {
            approverOpaque: caller.subjectOpaque,
            executionId,
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
            requesterOpaque: caller.subjectOpaque,
            status: "succeeded",
          },
          calls: [],
          executionId,
          status: "complete",
        }
      );
    },
    consumeNonce: (executionId, nonce) => {
      const valid = nonces.get(executionId) === nonce;

      if (valid) {
        nonces.delete(executionId);
      }

      return Promise.resolve(valid);
    },
    describeSite: (context) => {
      calls.describeSite.push(context);
      calls.order.push("describeSite");

      return outcome(overrides.describeSite?.() ?? siteDescription);
    },
    execute: (code, intent, context) => {
      calls.execute.push({ caller: context, code, intent });
      calls.order.push("execute");

      return outcome(overrides.execute?.() ?? pausedExecute);
    },
    getRun: (executionId, context) => {
      calls.getRun.push({ caller: context, executionId });
      calls.order.push("getRun");

      return outcome(overrides.getRun?.() ?? pausedRun);
    },
    issueNonce: (executionId) => {
      minted += 1;
      const nonce = `nonce-${executionId}-${minted}`;
      nonces.set(executionId, nonce);

      return Promise.resolve(nonce);
    },
    reject: (executionId, context) => {
      calls.reject.push({ caller: context, executionId });
      calls.order.push("reject");

      return outcome(
        overrides.reject?.() ?? {
          calls: [],
          executionId,
          status: "error",
        }
      );
    },
    verifyNonce: (executionId, nonce) =>
      Promise.resolve(nonces.get(executionId) === nonce),
  };

  return { calls, nonces, stub };
};

const toolServer = (
  stub: RuntimeStub,
  log: McpRequestLogger,
  support: ClientAppSupport = "advertised"
): McpServer => {
  const server = new McpServer({ name: "test", version: "0.0.0" });

  const deps: ToolDeps = {
    caller,
    executeDescriptions: [FAKE_EXECUTE_DESCRIPTION],
    origin: "https://wordpress.example",
    stub,
  };

  registerTools(server, deps, log, support);

  return server;
};

const withClient = async <T>(
  server: McpServer,
  withConnected: (client: Client) => Promise<T>
): Promise<T> => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return await withConnected(client);
  } finally {
    await client.close();
    await server.close();
  }
};

const callTool = (
  server: McpServer,
  name: string,
  args: Record<string, string>
): Promise<CallToolResult> =>
  withClient(server, (client) => client.callTool({ arguments: args, name }));

const summaryText = (result: CallToolResult): string => {
  const block = result.content.at(0);

  return block && block.type === "text" ? block.text : "";
};

const approvalTokenSchema = z.object({ approvalToken: z.string() });

const cardViewSchema = z.object({
  canApprove: z.boolean(),
  executionId: z.string(),
  html: z.string(),
  summary: z.string(),
});

const approvalToken = (result: CallToolResult): string =>
  approvalTokenSchema.parse(result._meta?.[APPROVAL_APP_META_KEY])
    .approvalToken;

describe("tool registration", () => {
  it("keeps the three code-mode tools and adds the two app-only tools", () => {
    const { stub } = stubRuntime();
    const server = toolServer(stub, requestLogger());

    const registered = (name: string): boolean =>
      server.toolInputSchemaJson(name) !== undefined;

    expect({
      decide_wordpress_write: registered("decide_wordpress_write"),
      describe_site: registered("describe_site"),
      execute: registered("execute"),
      get_run: registered("get_run"),
      inspect_wordpress_site: registered("inspect_wordpress_site"),
      preview_wordpress_write: registered("preview_wordpress_write"),
    }).toStrictEqual({
      decide_wordpress_write: true,
      describe_site: true,
      execute: true,
      get_run: true,
      inspect_wordpress_site: false,
      preview_wordpress_write: true,
    });
  });

  it("hides the app-only tools from a client that renders no app", async () => {
    const { stub } = stubRuntime();

    const listing = await withClient(
      toolServer(stub, requestLogger(), "absent"),
      (client) => client.listTools()
    );

    expect(listing.tools.map((tool) => tool.name).toSorted()).toStrictEqual([
      "describe_site",
      "execute",
      "get_run",
    ]);
    expect(
      listing.tools.find((tool) => tool.name === "execute")?._meta
    ).toBeUndefined();
  });

  it("serves no approval app resource to a client that renders no app", async () => {
    const { stub } = stubRuntime();

    const resources = await withClient(
      toolServer(stub, requestLogger(), "absent"),
      (client) => client.listResources()
    );

    expect(resources.resources).toStrictEqual([]);
  });

  it("advertises three model tools and three app-only tools", async () => {
    const { stub } = stubRuntime();

    const listing = await withClient(
      toolServer(stub, requestLogger()),
      (client) => client.listTools()
    );

    expect(listing.tools.map((tool) => tool.name).toSorted()).toStrictEqual([
      "decide_wordpress_write",
      "describe_site",
      "execute",
      "get_run",
      "preview_wordpress_write",
      "progress_wordpress_write",
    ]);
    expect(
      listing.tools.find((tool) => tool.name === "execute")?._meta
    ).toMatchObject({
      ui: { resourceUri: APPROVAL_APP_URI, visibility: ["model"] },
    });
    expect(
      listing.tools.find((tool) => tool.name === "decide_wordpress_write")
        ?._meta
    ).toMatchObject({
      ui: { resourceUri: APPROVAL_APP_URI, visibility: ["app"] },
    });
    expect(
      listing.tools.find((tool) => tool.name === "execute")?.outputSchema
    ).toMatchObject({
      properties: { status: { enum: ["complete", "error", "paused"] } },
      required: ["status"],
    });
  });

  it("advertises the proposal boundary as read-only and the decision as destructive", async () => {
    const { stub } = stubRuntime();

    const listing = await withClient(
      toolServer(stub, requestLogger()),
      (client) => client.listTools()
    );

    expect(
      listing.tools.find((tool) => tool.name === "execute")?.annotations
    ).toStrictEqual({
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(
      listing.tools.find((tool) => tool.name === "decide_wordpress_write")
        ?.annotations
    ).toStrictEqual({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    });
  });

  it("gives a fresh model the complete execute call contract", async () => {
    const { stub } = stubRuntime();

    const listing = await withClient(
      toolServer(stub, requestLogger()),
      (client) => client.listTools()
    );

    const execute = listing.tools.find((tool) => tool.name === "execute");

    const requiredGuidance = [
      "async JavaScript arrow function",
      "pauses for human approval in the inline app",
      FAKE_EXECUTE_DESCRIPTION,
    ];

    for (const guidance of requiredGuidance) {
      expect(execute?.description).toContain(guidance);
    }

    expect(execute?.inputSchema).toMatchObject({
      properties: {
        code: { description: expect.stringContaining("async JavaScript") },
        intent: {
          description: expect.stringContaining("one-sentence purpose"),
        },
      },
    });
  });

  it("serves a self-contained approval app that loads nothing", async () => {
    const { stub } = stubRuntime();

    const resource = await withClient(
      toolServer(stub, requestLogger()),
      (client) => client.readResource({ uri: APPROVAL_APP_URI })
    );

    const content = resource.contents.at(0);
    const text = content && "text" in content ? content.text : "";

    expect(content).toMatchObject({
      _meta: {
        ui: {
          csp: {
            baseUriDomains: [],
            connectDomains: [],
            frameDomains: [],
            resourceDomains: [],
          },
          prefersBorder: true,
        },
      },
      mimeType: "text/html;profile=mcp-app",
      uri: APPROVAL_APP_URI,
    });
    // The MCP Apps client is bundled into the document at build time, so
    // nothing is fetched at render time and no CDN is on the allowlist above.
    // Nothing in the bundle may close the script element either.
    // Exactly one closing tag: the card's own. A bundle that carried another
    // would end the script element early and put its remainder in the page.
    expect({
      cdn: text.includes("esm.sh"),
      closers: text.match(/<\/script/gu)?.length,
      handshake: text.includes("ui/initialize"),
      teardown: text.includes("ui/notifications/request-teardown"),
    }).toStrictEqual({
      cdn: false,
      closers: 1,
      handshake: true,
      teardown: true,
    });
    expect({
      decide: text.includes("decide_wordpress_write"),
      preview: text.includes("preview_wordpress_write"),
    }).toStrictEqual({ decide: true, preview: true });
  });

  it("keeps the current app available at every legacy URI", async () => {
    const { stub } = stubRuntime();

    const reads = await Promise.all(
      LEGACY_APPROVAL_APP_URIS.map((uri) =>
        withClient(toolServer(stub, requestLogger()), (client) =>
          client.readResource({ uri })
        )
      )
    );

    expect(reads.map((read) => read.contents.at(0)?.uri)).toStrictEqual(
      LEGACY_APPROVAL_APP_URIS
    );
  });
});

describe("describe_site output", () => {
  it("advertises an output schema for describe_site and get_run", async () => {
    const { stub } = stubRuntime();

    const listing = await withClient(
      toolServer(stub, requestLogger()),
      (client) => client.listTools()
    );

    const schemaFor = (name: string) =>
      listing.tools.find((tool) => tool.name === name)?.outputSchema;

    expect(schemaFor("describe_site")).toMatchObject({
      properties: { error: { type: "string" } },
      type: "object",
    });
    expect(schemaFor("get_run")).toMatchObject({
      required: ["calls", "executionId", "status"],
      type: "object",
    });
  });

  it("carries the site model as JSON in the text block", async () => {
    const { stub } = stubRuntime();

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "describe_site",
      {}
    );

    expect(JSON.parse(summaryText(result))).toStrictEqual({
      wp: wpDescription,
    });
  });

  it("truncates an oversized site model and says so", async () => {
    const huge: SiteDescription = [
      {
        connector: "wp",
        description: {
          ...wpDescription,
          contentTypes: Array.from({ length: 400 }, (_unused, index) => ({
            fields: Array.from(
              { length: 20 },
              (_field, position) => `field_${index}_${position}`
            ),
            name: `ContentType${index}`,
          })),
        },
      },
    ];

    const { stub } = stubRuntime({
      describeSite: () => Promise.resolve(huge),
    });

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "describe_site",
      {}
    );

    const text = summaryText(result);

    expect(text.length).toBeLessThan(20_200);
    expect(text).toContain("truncated");
  });
});

describe("execute", () => {
  it("omits approval state when execute finishes without a pending write", async () => {
    const { stub } = stubRuntime({
      execute: () =>
        Promise.resolve({
          calls: [],
          result: { title: "Hello" },
          status: "complete",
        }),
    });

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "execute",
      { code: "async () => wp.get({ path: '/wp-json/' })" }
    );

    expect(result._meta?.[APPROVAL_APP_META_KEY]).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ status: "complete" });
  });

  it("names the approval URL for a client that advertised nothing", async () => {
    const log = requestLogger();
    const { calls, stub } = stubRuntime();

    const result = await callTool(toolServer(stub, log, "unknown"), "execute", {
      code: "async () => wp.get({ path: '/wp-json/' })",
      intent: "Fix the headline",
    });

    expect(calls.execute).toStrictEqual([
      {
        caller,
        code: "async () => wp.get({ path: '/wp-json/' })",
        intent: "Fix the headline",
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      approvalUrl: "https://wordpress.example/mcp/approvals/exec_1",
      executionId: "exec_1",
      status: "paused",
    });
    expect(summaryText(result)).toContain(
      "https://wordpress.example/mcp/approvals/exec_1"
    );
    expect(summaryText(result)).toContain("Update title on pages 42");
  });

  it("still names the approval URL for a client that renders no card", async () => {
    const { stub } = stubRuntime();

    const result = await callTool(
      toolServer(stub, requestLogger(), "absent"),
      "execute",
      { code: "async () => wp.apply({})" }
    );

    expect(result._meta?.[APPROVAL_APP_META_KEY]).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      approvalUrl: "https://wordpress.example/mcp/approvals/exec_1",
    });
  });

  // The card carries the decision, so the model must not be handed an external
  // link to repeat beside it.
  it("withholds the approval URL once the card is armed", async () => {
    const { stub } = stubRuntime();

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "execute",
      { code: "async () => wp.apply({})" }
    );

    expect(result._meta?.[APPROVAL_APP_META_KEY]).toMatchObject({
      status: "pending",
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "/mcp/approvals/"
    );
    expect(summaryText(result)).not.toContain("/mcp/approvals/");
  });

  it("arms the card with a one-time token and previews nothing yet", async () => {
    const { calls, stub } = stubRuntime();

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "execute",
      { code: "async () => wp.apply({})", intent: "Fix the headline" }
    );

    expect(result._meta?.[APPROVAL_APP_META_KEY]).toStrictEqual({
      approvalToken: "nonce-exec_1-1",
      executionId: "exec_1",
      status: "pending",
    });
    // The before/after preview is built when the card opens, not now, so the
    // human sees the post as it is at decision time.
    expect(calls.getRun).toStrictEqual([]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("nonce-");
    expect(summaryText(result)).not.toContain("nonce-");
  });

  it("falls back to the approval link when the token cannot be minted", async () => {
    const { stub } = stubRuntime();

    const failing: RuntimeStub = {
      ...stub,
      issueNonce: () => Promise.reject(new Error("storage unavailable")),
    };

    const result = await callTool(
      toolServer(failing, requestLogger()),
      "execute",
      { code: "async () => wp.apply({})" }
    );

    expect(result._meta?.[APPROVAL_APP_META_KEY]).toMatchObject({
      executionId: "exec_1",
      status: "error",
    });
    expect(result.structuredContent).toMatchObject({
      approvalUrl: "https://wordpress.example/mcp/approvals/exec_1",
    });
  });

  it("previews the same before/after rows the approval page shows", async () => {
    const { calls, stub } = stubRuntime();
    const server = toolServer(stub, requestLogger());

    const preview = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      return await client.callTool({
        arguments: {
          approvalToken: approvalToken(execution),
          executionId: "exec_1",
        },
        name: "preview_wordpress_write",
      });
    });

    const view = cardViewSchema.parse(preview.structuredContent);

    expect(view.canApprove).toBeTruthy();
    expect(view.html).toContain("A corrected headline");
    expect(view.html).toContain("Update title on pages 42");
    expect(view.html).toContain("wp-admin");
    expect(calls.getRun).toStrictEqual([{ caller, executionId: "exec_1" }]);
  });

  it("escapes WordPress content in the fragment it hands the card", async () => {
    const { stub } = stubRuntime({
      getRun: () =>
        Promise.resolve({
          calls: [],
          executionId: "exec_1",
          preflight: {
            intent: "Fix the headline",
            operations: [
              {
                editUrl: "https://wordpress.example/wp-admin/post.php?post=42",
                fields: [
                  {
                    after: '<img src=x onerror="alert(1)">',
                    before: "<script>alert(1)</script>",
                    changed: true,
                    path: "title",
                  },
                ],
                modifiedGmt: "2026-09-16T20:00:00",
                operationIndex: 0,
                sentence: "Update title on pages 42",
                slug: "launch",
                target: "pages/42",
              },
            ],
          },
          status: "paused",
        }),
    });

    const server = toolServer(stub, requestLogger());

    const preview = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      return await client.callTool({
        arguments: {
          approvalToken: approvalToken(execution),
          executionId: "exec_1",
        },
        name: "preview_wordpress_write",
      });
    });

    const { html } = cardViewSchema.parse(preview.structuredContent);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("does not spend the token on a preview", async () => {
    const { calls, stub } = stubRuntime();
    const server = toolServer(stub, requestLogger());

    const decision = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      const token = approvalToken(execution);
      await client.callTool({
        arguments: { approvalToken: token, executionId: "exec_1" },
        name: "preview_wordpress_write",
      });
      await client.callTool({
        arguments: { approvalToken: token, executionId: "exec_1" },
        name: "preview_wordpress_write",
      });

      return await client.callTool({
        arguments: {
          approvalToken: token,
          decision: "approve",
          executionId: "exec_1",
        },
        name: "decide_wordpress_write",
      });
    });

    expect(decision._meta?.[APPROVAL_APP_META_KEY]).toMatchObject({
      status: "approved",
    });
    expect(calls.approve).toStrictEqual([{ caller, executionId: "exec_1" }]);
  });

  it("lets the app approve once with the one-time token", async () => {
    const log = requestLogger();
    const { calls, stub } = stubRuntime();
    const server = toolServer(stub, log);

    const second = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      const token = approvalToken(execution);

      const decision = await client.callTool({
        arguments: {
          approvalToken: token,
          decision: "approve",
          executionId: "exec_1",
        },
        name: "decide_wordpress_write",
      });

      expect(decision._meta?.[APPROVAL_APP_META_KEY]).toMatchObject({
        executionId: "exec_1",
        status: "approved",
      });
      expect(cardViewSchema.parse(decision.structuredContent).html).toContain(
        "Result: succeeded"
      );

      // The same token a second time answers nothing: it was spent above.
      return await client.callTool({
        arguments: {
          approvalToken: token,
          decision: "approve",
          executionId: "exec_1",
        },
        name: "decide_wordpress_write",
      });
    });

    expect(second.isError).toBeTruthy();
    expect(calls.approve).toStrictEqual([{ caller, executionId: "exec_1" }]);
    expect(log.getContext().approval).toMatchObject({
      decision: "approve",
      source: "mcp_app",
    });
  });

  it("issues a fresh token when the run pauses again and retires the old one", async () => {
    const { nonces, stub } = stubRuntime({
      approve: () =>
        Promise.resolve({ calls: [], executionId: "exec_1", status: "paused" }),
    });

    const server = toolServer(stub, requestLogger());

    const { first, second } = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      const firstToken = approvalToken(execution);

      const decision = await client.callTool({
        arguments: {
          approvalToken: firstToken,
          decision: "approve",
          executionId: "exec_1",
        },
        name: "decide_wordpress_write",
      });

      return { first: firstToken, second: approvalToken(decision) };
    });

    expect(second).not.toBe(first);
    expect(nonces.get("exec_1")).toBe(second);
    await expect(stub.verifyNonce("exec_1", first)).resolves.toBeFalsy();
  });

  // The token is spent before the runtime is called, so a decision that throws
  // would otherwise leave the run paused behind a dead card.
  it("re-arms the card and names the browser route when a decision fails", async () => {
    const { nonces, stub } = stubRuntime({
      approve: () => Promise.reject(new Error("the runtime failed")),
    });

    const server = toolServer(stub, requestLogger());

    const { first, result } = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      const token = approvalToken(execution);

      return {
        first: token,
        result: await client.callTool({
          arguments: {
            approvalToken: token,
            decision: "approve",
            executionId: "exec_1",
          },
          name: "decide_wordpress_write",
        }),
      };
    });

    const reissued = approvalToken(result);

    expect(result.isError).toBeTruthy();
    expect(reissued).not.toBe(first);
    expect(nonces.get("exec_1")).toBe(reissued);
    expect(cardViewSchema.parse(result.structuredContent).html).toContain(
      "https://wordpress.example/mcp/approvals/exec_1"
    );
  });

  it("refuses a forged token without answering the run", async () => {
    const { calls, stub } = stubRuntime();

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "decide_wordpress_write",
      {
        approvalToken: "00".repeat(32),
        decision: "approve",
        executionId: "exec_1",
      }
    );

    expect(result.isError).toBeTruthy();
    expect(result._meta?.[APPROVAL_APP_META_KEY]).toMatchObject({
      status: "error",
    });
    expect(calls.approve).toStrictEqual([]);
    expect(calls.reject).toStrictEqual([]);
    expect(calls.getRun).toStrictEqual([]);
  });

  it("refuses a preview for a token that was never issued", async () => {
    const { calls, stub } = stubRuntime();

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "preview_wordpress_write",
      { approvalToken: "00".repeat(32), executionId: "exec_1" }
    );

    expect(result.isError).toBeTruthy();
    expect(calls.getRun).toStrictEqual([]);
  });

  it("lets the app deny without writing", async () => {
    const { calls, stub } = stubRuntime();
    const server = toolServer(stub, requestLogger());

    const decision = await withClient(server, async (client) => {
      const execution = await client.callTool({
        arguments: { code: "async () => wp.apply({})" },
        name: "execute",
      });

      return await client.callTool({
        arguments: {
          approvalToken: approvalToken(execution),
          decision: "reject",
          executionId: "exec_1",
        },
        name: "decide_wordpress_write",
      });
    });

    expect(decision._meta?.[APPROVAL_APP_META_KEY]).toMatchObject({
      status: "denied",
    });
    expect(calls.reject).toStrictEqual([{ caller, executionId: "exec_1" }]);
    expect(calls.approve).toStrictEqual([]);
  });

  it("hides an unrecognised runtime failure behind a fixed message", async () => {
    const log = requestLogger();

    const { stub } = stubRuntime({
      execute: () =>
        Promise.reject(new TypeError("connect ECONNREFUSED 10.0.0.1:443")),
    });

    const result = await callTool(toolServer(stub, log), "execute", {
      code: "async () => 1",
    });

    expect(result.isError).toBeTruthy();
    expect(result.structuredContent).toMatchObject({
      error: "The runtime failed; see the wide event for details",
      status: "error",
    });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(log.getContext().mcp).toMatchObject({ errorName: "TypeError" });
  });

  it("keeps the message of a failure this Worker wrote itself", async () => {
    const { stub } = stubRuntime({
      execute: () =>
        Promise.reject(
          new UpstreamRequestError(
            "WordPress rejected the Access token. Reconnect the MCP client and retry."
          )
        ),
    });

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "execute",
      { code: "async () => 1" }
    );

    expect(result.structuredContent).toMatchObject({
      error:
        "WordPress rejected the Access token. Reconnect the MCP client and retry.",
    });
  });

  it("keeps the message when the RPC boundary flattened the error class away", async () => {
    // Cloudflare's RPC rebuilds a thrown error as a plain Error carrying the
    // original name and message, which is exactly what the tool sees.
    const flattened = new Error("batch addresses pages/7 more than once");
    flattened.name = "ApplyValidationError";

    const { stub } = stubRuntime({
      execute: () => Promise.reject(flattened),
    });

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "execute",
      { code: "async () => 1" }
    );

    expect(result.structuredContent).toMatchObject({
      error: "batch addresses pages/7 more than once",
    });
  });
});

describe("describe_site and get_run", () => {
  it("passes the caller to describe_site and the id to get_run", async () => {
    const { calls, stub } = stubRuntime();

    const describeResult = await callTool(
      toolServer(stub, requestLogger()),
      "describe_site",
      {}
    );

    const runResult = await callTool(
      toolServer(stub, requestLogger()),
      "get_run",
      { executionId: "exec_1" }
    );

    expect(calls.order).toStrictEqual(["describeSite", "getRun"]);
    expect(calls.describeSite).toStrictEqual([caller]);
    expect(calls.getRun).toStrictEqual([
      { caller: undefined, executionId: "exec_1" },
    ]);
    expect(describeResult.structuredContent).toMatchObject({
      wp: { site: { name: "Example" } },
    });
    expect(runResult.structuredContent).toMatchObject({
      executionId: "exec_1",
      status: "paused",
    });
  });

  it("names the failure beside the status of a rejected run", async () => {
    const { stub } = stubRuntime({
      getRun: () =>
        Promise.resolve({
          calls: [],
          error: "Action wp.apply rejected by user",
          executionId: "exec_1",
          status: "error",
        }),
    });

    const result = await callTool(
      toolServer(stub, requestLogger()),
      "get_run",
      {
        executionId: "exec_1",
      }
    );

    expect(summaryText(result)).toBe(
      "Run exec_1: error — Action wp.apply rejected by user"
    );
  });
});

describe("WordPress requests on the wide event", () => {
  it("records the runtime's request log for every tool", async () => {
    const executeLog = requestLogger();
    const describeLog = requestLogger();
    const runLog = requestLogger();
    const { stub } = stubRuntime();

    await callTool(toolServer(stub, executeLog), "execute", {
      code: "async () => 1",
    });
    await callTool(toolServer(stub, describeLog), "describe_site", {});
    await callTool(toolServer(stub, runLog), "get_run", {
      executionId: "exec_1",
    });

    expect({
      describe_site: describeLog.getContext().wordpress,
      execute: executeLog.getContext().wordpress,
      get_run: runLog.getContext().wordpress,
    }).toStrictEqual({
      describe_site: wordpress,
      execute: wordpress,
      get_run: wordpress,
    });
  });
});
