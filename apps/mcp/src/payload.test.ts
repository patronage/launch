import { verifyGatewayProof } from "@patronage/access";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplyPreflight } from "./apply";
import { createCallerScope } from "./caller";
import type { RuntimeStore } from "./connector";
import { createPayloadClient, payloadAdminUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { parseDraftApplyInput } from "./payload-operations";
import type { DraftOperation } from "./payload-operations";
import { createPayloadTools } from "./payload-tools";
import { invalidPendingApply, isApplyCall, toRunView } from "./run";
import { createWordPressTelemetry, WordPressRequestError } from "./wordpress";
import type { JsonObject } from "./wordpress";

const urlEnv: Env = {
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

// A Payload stand-in: one draft post, with `updatedAt` moving on every write.
const fakePayload = (options: { drafts?: boolean } = {}) => {
  const seen: Seen[] = [];

  let doc: JsonObject = {
    id: 12,
    slug: "hello",
    title: "Old title",
    updatedAt: "2026-10-31T10:00:00.000Z",
  };

  if (options.drafts !== false) {
    doc._status = "published";
  }

  let writes = 0;

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
        result: {
          content: [
            {
              text: `Document from collection "posts":\n${JSON.stringify(doc)}`,
              type: "text",
            },
          ],
        },
      });
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

    return Response.json(doc);
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
      telemetry: () => createWordPressTelemetry(),
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
    ).toThrow(WordPressRequestError);
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
      createWordPressTelemetry()
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
        createWordPressTelemetry()
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
      createWordPressTelemetry()
    );

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations: [operation],
      preflight,
      requesterOpaque: "requester0000000",
      telemetry: createWordPressTelemetry(),
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
      createWordPressTelemetry()
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
      telemetry: createWordPressTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({ status: "conflict" });
    expect(fake.seen.some((entry) => entry.method === "PATCH")).toBeFalsy();
  });
});

describe("a paused payload.apply", () => {
  it("is the write path a decision answers", () => {
    expect(isApplyCall({ connector: "payload", method: "apply" })).toBeTruthy();
    expect(isApplyCall({ connector: "payload", method: "call" })).toBeFalsy();
  });

  it("is validated with Payload's operations, not WordPress's", () => {
    expect(
      invalidPendingApply({
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
      invalidPendingApply({
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
      connector: "payload",
      intent: "Retitle",
      operations: [operation],
    });
  });
});
