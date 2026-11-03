import { verifyGatewayProof } from "@patronage/access";
import {
  ApplyValidationError,
  UpstreamRequestError,
  createCallerScope,
  createUpstreamTelemetry,
  invalidPendingApply,
  isApplyCall,
  toRunView,
} from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  JsonObject,
  PendingApplyParser,
  RuntimeStore,
} from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadAdminUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { payloadConnector } from "./payload-gateway";
import { parseDraftApplyInput } from "./payload-operations";
import type { DraftOperation } from "./payload-operations";
import { createPayloadTools } from "./payload-tools";

// The Payload connector's `apply` validation, as the runtime calls it.
const parse: PendingApplyParser = (_connector, args) =>
  payloadConnector.parseApply(args);

const urlEnv: PayloadEnv = {
  ACCESS_AUD: "aud",
  ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  APPROVAL_CSRF_SECRET: "csrf-secret",
  DEPLOYMENT_ENVIRONMENT: "test",
  PAYLOAD_ACCESS_CLIENT_ID: "client-id",
  PAYLOAD_ACCESS_CLIENT_SECRET: "client-secret",
  PAYLOAD_ACCESS_PROOF_SECRET: "proof-secret",
  PAYLOAD_ADMIN_URL: "",
  PAYLOAD_API_URL: "https://payload.example",
  WORDPRESS_API_URL: "https://wordpress.example",
};

const caller = { subjectOpaque: "editor0000000000", token: "editor-jwt" };

const operation: DraftOperation = {
  collection: "posts",
  fields: { title: "New title" },
  id: 12,
  kind: "update_draft",
};

interface Seen {
  body?: string;
  headers: Headers;
  method: string;
  url: string;
}

const stubLexicalSchema = z.object({ root: z.object({ md: z.string() }) });

// A Payload stand-in: one draft post, with `updatedAt` moving on every write,
// and the three read-only tools apps/payload adds. Its "Lexical" is a stub
// that keeps the Markdown under `root.md`, enough to tell the two apart.
const fakePayload = (
  options: {
    canCreate?: boolean;
    drafts?: boolean;
    failCreatedRead?: boolean;
    lost?: string[];
    status?: string;
  } = {}
) => {
  const seen: Seen[] = [];
  const drafts = options.drafts !== false;

  let doc: JsonObject = {
    content: { root: { md: "Old body" } },
    id: 12,
    slug: "hello",
    title: "Old title",
    updatedAt: "2026-10-31T10:00:00.000Z",
  };

  if (drafts) {
    doc._status = options.status ?? "published";
  }

  const created: Record<string, JsonObject> = {};
  let writes = 0;

  const toolResult = (name: string, args: JsonObject) => {
    if (name === "getEditingInfo") {
      const collections = [
        {
          canCreate: options.canCreate !== false,
          canUpdate: true,
          drafts,
          richTextFields: ["content"],
          slug: "posts",
        },
      ];

      return { content: [], structuredContent: { collections } };
    }

    if (name === "markdownToRichText") {
      return {
        content: [],
        structuredContent: { value: { root: { md: args.markdown ?? "" } } },
      };
    }

    if (name === "richTextToMarkdown") {
      const value = stubLexicalSchema.safeParse(args.value);

      return {
        content: [],
        structuredContent: {
          lost: options.lost ?? [],
          markdown: value.success ? value.data.root.md : "",
        },
      };
    }

    return {
      content: [
        {
          text: `Document from collection "posts":\n${JSON.stringify(doc)}`,
          type: "text",
        },
      ],
    };
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? undefined : await request.text();
    seen.push({
      body,
      headers: request.headers,
      method: request.method,
      url: request.url,
    });
    const url = new URL(request.url);

    if (url.pathname === "/api/mcp") {
      const rpc = JSON.parse(body ?? "{}");

      if (rpc.method === "tools/list") {
        return Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: {
            tools: [
              { inputSchema: { type: "object" }, name: "findDocuments" },
              { name: "updateDocument" },
            ],
          },
        });
      }

      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: toolResult(rpc.params.name, rpc.params.arguments ?? {}),
      });
    }

    if (request.method === "POST") {
      const next: JsonObject = {
        _status: "draft",
        ...JSON.parse(body ?? "{}"),
        id: 34,
        updatedAt: "2026-10-31T12:00:00.000Z",
      };

      created["/api/posts/34"] = next;

      return Response.json({ doc: next, message: "Created successfully." });
    }

    if (request.method === "PATCH") {
      writes += 1;
      doc = {
        ...doc,
        ...JSON.parse(body ?? "{}"),
        updatedAt: `2026-10-31T11:00:0${writes}.000Z`,
      };

      return Response.json({ doc, message: "Updated successfully." });
    }

    if (options.failCreatedRead && created[url.pathname]) {
      return Response.json({ errors: [{ message: "Down" }] }, { status: 500 });
    }

    return Response.json(created[url.pathname] ?? doc);
  };

  return { handler, seen };
};

const memoryStore = (preflight?: ApplyPreflight): RuntimeStore => ({
  readPreflight: () => Promise.resolve(preflight),
  readRequester: () => Promise.resolve("requester0000000"),
  writePreflight: () => Promise.resolve(),
});

const connectorTools = () => {
  const scope = createCallerScope();

  return {
    payload: createPayloadTools({
      env: urlEnv,
      scope,
      store: memoryStore(),
      telemetry: () => createUpstreamTelemetry(),
    }),
    scope,
  };
};

const client = () => createPayloadClient(urlEnv, caller);

const adminUrl = (collection: string, id: number | string) =>
  payloadAdminUrl(
    { ...urlEnv, PAYLOAD_ADMIN_URL: "https://cms.example" },
    collection,
    id
  );

describe(parseDraftApplyInput, () => {
  it("accepts top-level field changes to one document", () => {
    expect(
      parseDraftApplyInput({ intent: "Retitle", operations: [operation] })
        .operations
    ).toHaveLength(1);
  });

  it.each(["_status", "id", "updatedAt", "createdAt"])(
    "refuses the Payload-managed field %j",
    (field) => {
      expect(() =>
        parseDraftApplyInput({
          intent: "Publish",
          operations: [{ ...operation, fields: { [field]: "published" } }],
        })
      ).toThrow(/invalid_operations|fields/u);
    }
  );

  it("accepts a new draft and Markdown for rich text", () => {
    expect(
      parseDraftApplyInput({
        intent: "Draft two posts",
        operations: [
          {
            collection: "posts",
            kind: "create_draft",
            markdown: { content: "# Hi" },
          },
          {
            collection: "posts",
            fields: { title: "Two" },
            kind: "create_draft",
          },
        ],
      }).operations
    ).toHaveLength(2);
  });

  it("refuses a field given both as a value and as Markdown", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Both",
        operations: [
          {
            ...operation,
            fields: { content: {} },
            markdown: { content: "Body" },
          },
        ],
      })
    ).toThrow(/both fields and markdown/u);
  });

  it("refuses two operations on one document", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Twice",
        operations: [operation, operation],
      })
    ).toThrow(/more than once/u);
  });
});

describe(createPayloadClient, () => {
  it("requires the gateway proof secret", () => {
    expect(() =>
      createPayloadClient(
        { ...urlEnv, PAYLOAD_ACCESS_PROOF_SECRET: "" },
        caller
      )
    ).toThrow(UpstreamRequestError);
  });

  it("prefers the Service binding over the URL", () => {
    const fetcher = {
      connect: vi.fn<Fetcher["connect"]>(),
      fetch: vi.fn<Fetcher["fetch"]>(),
    } satisfies Fetcher;

    const bound = createPayloadClient({ ...urlEnv, PAYLOAD: fetcher }, caller);

    expect(bound.fetcher).toBe(fetcher);
    expect(bound.auth.serviceToken).toBeUndefined();
  });
});

describe("payload.call and payload.tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the editor's JWT with a gateway proof and the service token", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);
    const { payload, scope } = connectorTools();

    const result = await scope.run(caller, () =>
      payload.call.execute({
        arguments: { id: 12, slug: "posts" },
        tool: "findDocuments",
      })
    );

    expect(JSON.stringify(result)).toContain("Old title");
    const [request] = fake.seen;
    expect(request?.url).toBe("https://payload.example/api/mcp");
    expect(request?.headers.get("X-Access-User-Jwt")).toBe("editor-jwt");
    expect(request?.headers.get("CF-Access-Client-Id")).toBe("client-id");
    expect(request?.headers.get("Accept")).toContain("text/event-stream");
  });

  it("signs a gateway proof over the editor's JWT", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);
    const { payload, scope } = connectorTools();

    await scope.run(caller, () =>
      payload.call.execute({
        arguments: { id: 12, slug: "posts" },
        tool: "findDocuments",
      })
    );

    const [request] = fake.seen;
    await expect(
      verifyGatewayProof(
        request?.headers.get("X-Access-Gateway-Proof") ?? "",
        "editor-jwt",
        "proof-secret"
      )
    ).resolves.toBeTruthy();
  });

  it("refuses a tool that is not on the read list", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);
    const { payload, scope } = connectorTools();

    await expect(
      scope.run(caller, () =>
        payload.call.execute({
          arguments: { data: { title: "x" }, id: 12, slug: "posts" },
          tool: "updateDocument",
        })
      )
    ).rejects.toThrow(/read tools only/u);
    expect(fake.seen).toHaveLength(0);
  });

  it("lists only the read tools Payload offers", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);
    const { payload, scope } = connectorTools();

    await expect(
      scope.run(caller, () => payload.tools.execute({}))
    ).resolves.toStrictEqual([
      { inputSchema: { type: "object" }, name: "findDocuments" },
    ]);
  });
});

describe("Payload draft writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("previews the change against the current draft", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Retitle",
      [operation],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]).toMatchObject({
      editUrl: "https://cms.example/admin/collections/posts/12",
      editor: "Payload admin",
      fields: [
        {
          after: "New title",
          before: "Old title",
          changed: true,
          path: "title",
        },
      ],
      modifiedGmt: "2026-10-31T10:00:00.000Z",
      target: "posts/12",
    });
  });

  it("refuses a collection without drafts, since the write would publish", async () => {
    vi.stubGlobal("fetch", fakePayload({ drafts: false }).handler);

    await expect(
      preflightDraftOperations(
        client(),
        "Retitle",
        [operation],
        adminUrl,
        createUpstreamTelemetry()
      )
    ).rejects.toMatchObject({ code: "drafts_not_enabled" });
  });

  it("saves the approved change as a draft and reads it back", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Retitle",
      [operation],
      adminUrl,
      createUpstreamTelemetry()
    );

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [operation],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.status).toBe("succeeded");
    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["title"],
      kind: "update_draft",
      status: "changed",
    });
    const write = fake.seen.find((entry) => entry.method === "PATCH");
    expect(write?.url).toBe(
      "https://payload.example/api/posts/12?draft=true&depth=0"
    );
    expect(write?.body).toBe(JSON.stringify({ title: "New title" }));
  });

  it("reports a conflict when the draft changed after the preview", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Retitle",
      [operation],
      adminUrl,
      createUpstreamTelemetry()
    );

    const stale: ApplyPreflight = {
      ...preflight,
      operations: preflight.operations.map((entry) => ({
        ...entry,
        modifiedGmt: "2026-10-30T00:00:00.000Z",
      })),
    };

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [operation],
      preflight: stale,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({ status: "conflict" });
    expect(fake.seen.some((entry) => entry.method === "PATCH")).toBeFalsy();
  });
});

describe("Payload publishing on request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publishOnly: DraftOperation = {
    collection: "posts",
    id: 12,
    kind: "update_draft",
    publish: true,
  };

  it("accepts a publish with no field changes on an update only", () => {
    expect(
      parseDraftApplyInput({ intent: "Publish", operations: [publishOnly] })
    ).toMatchObject({ operations: [publishOnly] });

    expect(() =>
      parseDraftApplyInput({
        intent: "Start",
        operations: [
          { collection: "posts", kind: "create_draft", publish: true },
        ],
      })
    ).toThrow(/at least one field/u);

    expect(() =>
      parseDraftApplyInput({
        intent: "Retitle",
        operations: [{ ...operation, publish: false }],
      })
    ).toThrow(ApplyValidationError);
  });

  it("refuses _status in fields, so publishing goes through publish", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Publish",
        operations: [{ ...operation, fields: { _status: "published" } }],
      })
    ).toThrow(ApplyValidationError);
  });

  it("shows the publish as a _status change in the preview", async () => {
    vi.stubGlobal("fetch", fakePayload({ status: "draft" }).handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Publish",
      [publishOnly],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]).toMatchObject({
      fields: [
        { after: "published", before: "draft", changed: true, path: "_status" },
      ],
      sentence: "Publish posts 12",
    });
  });

  it("publishes the approved change without draft=true", async () => {
    const fake = fakePayload({ status: "draft" });
    vi.stubGlobal("fetch", fake.handler);
    const publishing: DraftOperation = { ...operation, publish: true };

    const preflight = await preflightDraftOperations(
      client(),
      "Retitle and publish",
      [publishing],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]?.sentence).toBe(
      "Save title to posts 12 and publish it"
    );

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [publishing],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["_status", "title"],
      status: "changed",
    });

    const write = fake.seen.find((entry) => entry.method === "PATCH");

    expect(write?.url).toBe("https://payload.example/api/posts/12?depth=0");
    expect(JSON.parse(write?.body ?? "{}")).toStrictEqual({
      _status: "published",
      title: "New title",
    });
  });

  it("creates a published document when asked", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);

    const creating: DraftOperation = {
      collection: "posts",
      fields: { title: "Launch day" },
      kind: "create_draft",
      publish: true,
    };

    const preflight = await preflightDraftOperations(
      client(),
      "Announce",
      [creating],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]?.sentence).toBe(
      "Create and publish a new posts with title"
    );

    await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [creating],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    const write = fake.seen.find(
      (entry) => entry.method === "POST" && !entry.url.endsWith("/api/mcp")
    );

    expect(write?.url).toBe("https://payload.example/api/posts?depth=0");
    expect(JSON.parse(write?.body ?? "{}")).toMatchObject({
      _status: "published",
    });
  });
});

describe("Payload Markdown and new drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const markdownOperation: DraftOperation = {
    collection: "posts",
    id: 12,
    kind: "update_draft",
    markdown: { content: "New body" },
  };

  const createOperation: DraftOperation = {
    collection: "posts",
    fields: { title: "Fresh" },
    kind: "create_draft",
    markdown: { content: "First words" },
  };

  it("previews rich text as Markdown and writes it as Lexical", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Rewrite",
      [markdownOperation],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]?.fields).toStrictEqual([
      { after: "New body", before: "Old body", changed: true, path: "content" },
    ]);

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [markdownOperation],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["content"],
      status: "changed",
    });
    expect(fake.seen.find((entry) => entry.method === "PATCH")?.body).toBe(
      JSON.stringify({ content: { root: { md: "New body" } } })
    );
  });

  it("leaves rich text alone when its Markdown is unchanged", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);

    const same: DraftOperation = {
      ...markdownOperation,
      markdown: { content: "Old body\n" },
    };

    const preflight = await preflightDraftOperations(
      client(),
      "Rewrite",
      [same],
      adminUrl,
      createUpstreamTelemetry()
    );

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [same],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({ status: "unchanged" });
    expect(fake.seen.some((entry) => entry.method === "PATCH")).toBeFalsy();
  });

  it("refuses Markdown that would drop blocks Markdown cannot carry", async () => {
    vi.stubGlobal("fetch", fakePayload({ lost: ["block"] }).handler);

    await expect(
      preflightDraftOperations(
        client(),
        "Rewrite",
        [markdownOperation],
        adminUrl,
        createUpstreamTelemetry()
      )
    ).rejects.toMatchObject({ code: "markdown_would_lose_content" });
  });

  it("counts a change of leading indentation as a change", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Indent",
      [{ ...markdownOperation, markdown: { content: "    Old body" } }],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]?.fields[0]?.changed).toBeTruthy();
  });

  it("refuses Markdown for a field that is not rich text", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflightDraftOperations(
        client(),
        "Rewrite",
        [{ ...markdownOperation, markdown: { title: "Plain" } }],
        adminUrl,
        createUpstreamTelemetry()
      )
    ).rejects.toMatchObject({ code: "not_rich_text" });
  });

  it("previews a new draft with nothing before it", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Start a post",
      [createOperation],
      adminUrl,
      createUpstreamTelemetry()
    );

    expect(preflight.operations[0]).toMatchObject({
      editUrl: "",
      fields: [
        { after: "First words", before: "", changed: true, path: "content" },
        { after: "Fresh", before: "", changed: true, path: "title" },
      ],
      modifiedGmt: "",
      sentence: "Create a new posts draft with content and title",
      target: "posts/new",
    });
  });

  it("creates the approved draft and names it in the receipt", async () => {
    const fake = fakePayload();
    vi.stubGlobal("fetch", fake.handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Start a post",
      [createOperation],
      adminUrl,
      createUpstreamTelemetry()
    );

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [createOperation],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["content", "title"],
      kind: "create_draft",
      status: "changed",
      target: "posts/34",
    });

    const write = fake.seen.find(
      (entry) => entry.method === "POST" && !entry.url.endsWith("/api/mcp")
    );

    expect(write?.url).toBe(
      "https://payload.example/api/posts?draft=true&depth=0"
    );
    expect(JSON.parse(write?.body ?? "{}")).not.toHaveProperty("_status");
  });

  it("names a created draft even when reading it back fails", async () => {
    vi.stubGlobal("fetch", fakePayload({ failCreatedRead: true }).handler);

    const preflight = await preflightDraftOperations(
      client(),
      "Start a post",
      [createOperation],
      adminUrl,
      createUpstreamTelemetry()
    );

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [createOperation],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({
      error: { code: "created_readback_failed" },
      status: "failed",
      target: "posts/34",
    });
  });

  it("refuses a new draft where the editor may not create", async () => {
    vi.stubGlobal("fetch", fakePayload({ canCreate: false }).handler);

    await expect(
      preflightDraftOperations(
        client(),
        "Start a post",
        [createOperation],
        adminUrl,
        createUpstreamTelemetry()
      )
    ).rejects.toMatchObject({ code: "not_permitted" });
  });
});

describe("a paused payload.apply", () => {
  it("is the write path a decision answers", () => {
    expect(isApplyCall({ connector: "payload", method: "apply" })).toBeTruthy();
    expect(isApplyCall({ connector: "payload", method: "call" })).toBeFalsy();
  });

  it("is validated with Payload's operations, not WordPress's", () => {
    expect(
      invalidPendingApply(parse, {
        executionId: "exec_1",
        pending: [
          {
            args: {
              intent: "Publish",
              operations: [{ ...operation, fields: { _status: "published" } }],
            },
            connector: "payload",
            method: "apply",
            seq: 3,
          },
        ],
        status: "paused",
      })
    ).toMatchObject({
      code: "invalid_operations",
      connector: "payload",
      seq: 3,
    });

    expect(
      invalidPendingApply(parse, {
        executionId: "exec_1",
        pending: [
          {
            args: { intent: "Retitle", operations: [operation] },
            connector: "payload",
            method: "apply",
            seq: 3,
          },
        ],
        status: "paused",
      })
    ).toBeUndefined();
  });

  it("reports its operations as Payload's for the preview", () => {
    const view = toRunView("exec_1", {
      id: "exec_1",
      log: [
        {
          args: { intent: "Retitle", operations: [operation] },
          connector: "payload",
          method: "apply",
          seq: 1,
          state: "pending",
        },
      ],
      status: "paused",
    });

    expect(view.pending).toStrictEqual({
      args: { intent: "Retitle", operations: [operation] },
      connector: "payload",
    });
  });
});
