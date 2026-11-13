import { createUpstreamTelemetry } from "@patronage/mcp-core";
import type { ApplyPreflight, JsonObject } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadSiteUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { parseDraftApplyInput } from "./payload-operations";
import type { PayloadOperation } from "./payload-operations";

const env: PayloadEnv = {
  PAYLOAD_ACCESS_PROOF_SECRET: "proof-secret",
  PAYLOAD_ADMIN_URL: "https://cms.example",
  PAYLOAD_API_URL: "https://payload.example",
};

const client = () =>
  createPayloadClient(env, {
    subjectOpaque: "editor0000000000",
    token: "editor-jwt",
  });

const READ_AT = "2026-11-13T10:00:00.000Z";
const SAVED_AT = "2026-11-13T11:00:00.000Z";

const collection = (slug: string, rest: JsonObject = {}): JsonObject => ({
  canCreate: true,
  canUpdate: true,
  drafts: true,
  preview: true,
  richTextFields: [],
  slug,
  ...rest,
});

interface FakeOptions {
  // What `getPreviewUrl` answers with: a Payload from before `path` leaves
  // it out.
  address?: JsonObject;
  // Collections beside posts.
  collections?: JsonObject[];
  // A hook that keeps the post published whatever is sent.
  keepsPublished?: boolean;
  locked?: boolean;
  // The post as the public sees it.
  publicStatus?: string;
  redirects?: JsonObject[];
}

// A Payload stand-in with one post, published, with a newer draft saved
// since. Unpublishing it works the way Payload's own does.
const fakePayload = (options: FakeOptions = {}) => {
  const writes: { body: JsonObject; search: string }[] = [];
  const redirectReads: string[] = [];
  let publicStatus = options.publicStatus ?? "published";
  let stamp = READ_AT;

  const info = {
    collections: [
      collection("posts"),
      collection("redirects", { drafts: false, preview: false }),
      ...(options.collections ?? []),
    ],
  };

  const tool = (rpc: { params: { name: string } }) =>
    rpc.params.name === "getEditingInfo"
      ? { content: [], structuredContent: info }
      : {
          content: [],
          structuredContent: options.address ?? {
            path: "/news/hello",
            url: "/next/preview?path=%2Fnews%2Fhello",
          },
        };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/api/mcp") {
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: tool(await request.json()),
      });
    }

    if (url.pathname === "/api/redirects") {
      redirectReads.push(url.searchParams.get("where[from][equals]") ?? "");

      return Response.json({ docs: options.redirects ?? [] });
    }

    if (url.pathname.endsWith("/versions")) {
      return Response.json({
        docs: [{ id: 18, version: { updatedAt: stamp } }],
      });
    }

    if (request.method === "PATCH") {
      if (options.locked) {
        return Response.json({ errors: [] }, { status: 423 });
      }

      writes.push({ body: await request.json(), search: url.search });
      stamp = SAVED_AT;

      if (!options.keepsPublished) {
        publicStatus = "draft";
      }

      return Response.json({ doc: { _status: "draft", updatedAt: stamp } });
    }

    // The document itself, or its newest version.
    return Response.json(
      url.searchParams.get("draft") === "true"
        ? { _status: "draft", slug: "hello", title: "Hello", updatedAt: stamp }
        : { _status: publicStatus, id: 3 }
    );
  };

  return {
    handler,
    redirectReads,
    // Another editor saves the post between the preview and the write.
    touch: () => {
      stamp = "2026-11-13T10:30:00.000Z";
    },
    writes,
  };
};

const unpublish = (rest: JsonObject = {}): PayloadOperation => ({
  collection: "posts",
  expected_updated_at: READ_AT,
  id: 3,
  kind: "unpublish",
  ...rest,
});

const preflight = (operations: PayloadOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Take the post down",
    operations,
    (slug, id) => `https://cms.example/admin/collections/${slug}/${id}`,
    createUpstreamTelemetry(),
    { siteUrl: (link) => payloadSiteUrl(env, link) }
  );

const apply = async (
  operations: PayloadOperation[],
  between: () => void = () => {
    // Nothing happens between the preview and the write.
  }
) => {
  const approved = await preflight(operations);

  between();

  const receipt = await applyDraftOperations({
    approverOpaque: "approver00000000",
    client: client(),
    executionId: "exec_1",
    operations,
    preflight: approved,
    requesterOpaque: "requester0000000",
    siteUrl: (link) => payloadSiteUrl(env, link),
    telemetry: createUpstreamTelemetry(),
  });

  return receipt.operations;
};

describe("unpublish preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the status change and where the page is, with no redirect", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const preview = await preflight([unpublish()]);

    expect(preview.operations).toStrictEqual([
      {
        editUrl: "https://cms.example/admin/collections/posts/3",
        editor: "Payload admin",
        fields: [
          {
            after: "draft",
            before: "published",
            changed: true,
            path: "_status",
          },
        ],
        modifiedGmt: READ_AT,
        operationIndex: 0,
        previewUrl: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
        sentence: "Unpublish posts 3",
        slug: "hello",
        target: "posts/3",
        warning:
          "The public page at /news/hello goes away as soon as you approve. No redirect from that path exists, so links to it will 404.",
      },
    ]);
    expect(fake.redirectReads).toStrictEqual(["/news/hello"]);
  });

  it("says when a redirect from the path exists", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({ redirects: [{ from: "/news/hello", id: 1 }] }).handler
    );

    const preview = await preflight([unpublish()]);

    expect(preview.operations[0]?.warning).toBe(
      "The public page at /news/hello goes away as soon as you approve. A redirect from that path exists, so links to it will follow the redirect."
    );
  });

  it("warns without a path when Payload gives none", async () => {
    const fake = fakePayload({
      address: { url: "/next/preview?path=%2Fnews%2Fhello" },
    });

    vi.stubGlobal("fetch", fake.handler);

    const preview = await preflight([unpublish()]);

    expect(preview.operations[0]?.warning).toBe(
      "The public page goes away as soon as you approve. Links to it will 404 unless a redirect exists."
    );
    expect(fake.redirectReads).toStrictEqual([]);
  });

  it.each<[string, FakeOptions, JsonObject]>([
    ["already_draft", { publicStatus: "draft" }, {}],
    ["stale_expected_updated_at", {}, { expected_updated_at: "2026-11-01" }],
    ["unknown_collection", {}, { collection: "events" }],
    [
      "drafts_not_enabled",
      { collections: [collection("media", { drafts: false })] },
      { collection: "media" },
    ],
    [
      "not_permitted",
      { collections: [collection("pages", { canUpdate: false })] },
      { collection: "pages" },
    ],
  ])("refuses with %s", async (code, options, operation) => {
    const fake = fakePayload(options);

    vi.stubGlobal("fetch", fake.handler);

    await expect(preflight([unpublish(operation)])).rejects.toMatchObject({
      code,
    });
    expect(fake.writes).toHaveLength(0);
  });
});

describe("unpublish", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends what the admin's Unpublish button sends", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([unpublish()]);

    expect(fake.writes).toStrictEqual([
      {
        body: { _status: "draft" },
        search: "?depth=0&unpublishAllLocales=true",
      },
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["_status"],
      details: {
        preview_url: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
      },
      kind: "unpublish",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "posts/3",
      updated_at: SAVED_AT,
      version_id: "18",
    });
  });

  it("writes nothing when the post changed after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([unpublish()], fake.touch);

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
  });

  it("reports a post another editor has open as locked", async () => {
    vi.stubGlobal("fetch", fakePayload({ locked: true }).handler);

    const [receipt] = await apply([unpublish()]);

    expect(receipt).toMatchObject({
      error: { code: "locked" },
      status: "conflict",
    });
  });

  it("fails when Payload keeps the post published", async () => {
    vi.stubGlobal("fetch", fakePayload({ keepsPublished: true }).handler);

    const [receipt] = await apply([unpublish()]);

    expect(receipt).toMatchObject({
      changed_paths: [],
      error: { code: "still_published" },
      status: "failed",
      updated_at: SAVED_AT,
    });
  });
});

const parse = (operation: JsonObject) =>
  parseDraftApplyInput({ intent: "Take it down", operations: [operation] });

const operation: JsonObject = {
  collection: "posts",
  expected_updated_at: READ_AT,
  id: 3,
  kind: "unpublish",
};

describe("unpublish in payload.apply", () => {
  it("takes a collection, an id and what was read", () => {
    expect(parse(operation).operations).toHaveLength(1);
  });

  it.each<[string, JsonObject]>([
    [
      "no expected_updated_at",
      { collection: "posts", id: 3, kind: "unpublish" },
    ],
    ["fields", { ...operation, fields: { title: "x" } }],
    ["publish", { ...operation, publish: true }],
  ])("refuses %s", (_name, input) => {
    expect(() => parse(input)).toThrow(/invalid|operations/iu);
  });

  it("refuses to unpublish and change one document in one batch", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Take it down",
        operations: [
          operation,
          {
            collection: "posts",
            fields: { title: "x" },
            id: 3,
            kind: "update_draft",
          },
        ],
      })
    ).toThrow(/more than once/u);
  });
});
