import { createUpstreamTelemetry } from "@patronage/mcp-core";
import type { ApplyPreflight, JsonObject } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
const TRASHED_AT = "2026-11-12T09:00:00.000Z";

const collection = (slug: string, rest: JsonObject = {}): JsonObject => ({
  canCreate: true,
  canDelete: true,
  canUpdate: true,
  drafts: true,
  preview: true,
  richTextFields: [],
  slug,
  titleField: "title",
  trash: true,
  ...rest,
});

const POSTS = collection("posts", {
  relationFields: [
    { hasMany: true, path: "related", relationTo: ["posts"] },
    { hasMany: false, path: "updatedBy", relationTo: ["users"] },
  ],
});

const REDIRECTS = collection("redirects", {
  drafts: false,
  preview: false,
  relationFields: [
    {
      hasMany: false,
      path: "to.reference",
      polymorphic: true,
      relationTo: ["pages", "posts"],
    },
  ],
  titleField: "from",
  trash: false,
});

interface FakeOptions {
  // Collections beside posts and redirects.
  collections?: JsonObject[];
  // The newest version's status, where it differs from the public one.
  draftStatus?: string;
  // A hook that keeps the document where it was whatever is sent.
  ignoresWrite?: boolean;
  // A hook that keeps a restored document a draft.
  keepsDraft?: boolean;
  locked?: boolean;
  // The post as the public sees it.
  publicStatus?: string;
  // How many redirects point at the post.
  redirects?: number;
  // The post starts in the trash.
  trashed?: boolean;
}

interface Write {
  body: JsonObject;
  search: string;
}

// A Payload stand-in with one post, which keeps a trash the way Payload
// does: a trashed document is left out of every read that does not ask for
// it, and saving `deletedAt` moves it in and out.
const fakePayload = (options: FakeOptions = {}) => {
  const reads: string[] = [];
  const writes: Write[] = [];
  let deletedAt: string | null = options.trashed ? TRASHED_AT : null;
  let publicStatus = options.publicStatus ?? "published";
  let stamp = READ_AT;

  const info = {
    collections: [POSTS, REDIRECTS, ...(options.collections ?? [])],
  };

  const tool = (rpc: { params: { name: string } }) =>
    rpc.params.name === "getEditingInfo"
      ? { content: [], structuredContent: info }
      : {
          content: [],
          structuredContent: {
            path: "/news/hello",
            url: "/next/preview?path=%2Fnews%2Fhello",
          },
        };

  const save = (body: JsonObject): void => {
    stamp = SAVED_AT;

    if (options.ignoresWrite) {
      return;
    }

    const trashedAt = z.string().safeParse(body.deletedAt);

    if (trashedAt.success) {
      deletedAt = trashedAt.data;

      return;
    }

    deletedAt = null;
    publicStatus = options.keepsDraft ? "draft" : String(body._status);
  };

  const post = (url: URL): Response => {
    if (deletedAt !== null && url.searchParams.get("trash") !== "true") {
      return Response.json({ errors: [] }, { status: 404 });
    }

    return Response.json(
      url.searchParams.has("select[_status]")
        ? { _status: publicStatus, id: 3 }
        : {
            _status: options.draftStatus ?? publicStatus,
            deletedAt,
            id: 3,
            slug: "hello",
            title: "Hello",
            updatedAt: stamp,
          }
    );
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

    if (request.method === "GET") {
      reads.push(`${url.pathname}${decodeURIComponent(url.search)}`);
    }

    if (url.pathname.endsWith("/versions")) {
      return Response.json({
        docs: [{ id: 18, version: { updatedAt: stamp } }],
      });
    }

    if (url.pathname === "/api/redirects") {
      const total = options.redirects ?? 0;

      return Response.json({
        docs: Array.from({ length: Math.min(total, 5) }, (_, index) => ({
          from: `/old-${index + 1}`,
          id: index + 1,
        })),
        totalDocs: total,
      });
    }

    // The posts that point at this one: none.
    if (url.pathname === "/api/posts") {
      return Response.json({ docs: [], totalDocs: 0 });
    }

    if (request.method === "PATCH") {
      if (options.locked) {
        return Response.json({ errors: [] }, { status: 423 });
      }

      const body: JsonObject = await request.json();

      writes.push({ body, search: url.search });
      save(body);

      return Response.json({ doc: { updatedAt: stamp } });
    }

    return post(url);
  };

  return {
    handler,
    reads,
    // Another editor saves the post between the preview and the write.
    touch: () => {
      stamp = "2026-11-13T10:30:00.000Z";
    },
    writes,
  };
};

const trash = (rest: JsonObject = {}): PayloadOperation => ({
  collection: "posts",
  expected_updated_at: READ_AT,
  id: 3,
  kind: "trash",
  ...rest,
});

const restore = (rest: JsonObject = {}): PayloadOperation => ({
  collection: "posts",
  expected_updated_at: READ_AT,
  id: 3,
  kind: "restore_from_trash",
  ...rest,
});

const preflight = (operations: PayloadOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Tidy up",
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

describe("trash preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the document, where its page is and what points at it", async () => {
    const fake = fakePayload({ redirects: 7 });

    vi.stubGlobal("fetch", fake.handler);

    const preview = await preflight([trash()]);

    expect(preview.operations).toStrictEqual([
      {
        editUrl: "https://cms.example/admin/collections/posts/3",
        editor: "Payload admin",
        fields: [
          {
            after: "in the trash",
            before: "“Hello”, published",
            changed: true,
            label: "Trash",
            path: "deletedAt",
          },
          {
            after: "still pointing at it, in the trash",
            before:
              "redirects 1 “/old-1”, redirects 2 “/old-2”, redirects 3 “/old-3”, redirects 4 “/old-4”, redirects 5 “/old-5” and 2 more",
            changed: true,
            label: "Linked from at least",
            path: "(links)",
          },
        ],
        modifiedGmt: READ_AT,
        operationIndex: 0,
        previewUrl: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
        sentence: "Move posts 3 to the trash",
        slug: "hello",
        target: "posts/3",
        warning:
          "The public page at /news/hello goes away as soon as you approve, and links to it will 404. It moves to the trash, where it can be restored as a draft.",
      },
    ]);
  });

  it("asks each relationship field the way Payload stores it", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    await preflight([trash()]);

    expect(
      fake.reads.filter((read) => read.includes("where[and]"))
    ).toStrictEqual([
      // One collection, the id itself; never the post through itself.
      "/api/posts?depth=0&draft=true&limit=5&select[title]=true&where[and][0][related][equals]=3&where[and][2][id][not_equals]=3",
      // A list of collections, stored as { relationTo, value }.
      "/api/redirects?depth=0&draft=true&limit=5&select[from]=true&where[and][0][to.reference.value][equals]=3&where[and][1][to.reference.relationTo][equals]=posts",
    ]);
  });

  it("leaves the links row out when nothing points at it", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([trash()]);

    expect(preview.operations[0]?.fields).toHaveLength(1);
  });

  it("says a draft only moves to the trash", async () => {
    vi.stubGlobal("fetch", fakePayload({ publicStatus: "draft" }).handler);

    const preview = await preflight([trash()]);

    expect(preview.operations[0]).toMatchObject({
      fields: [{ before: "“Hello”, draft" }],
      warning: "It moves to the trash, where it can be restored as a draft.",
    });
  });

  it("says a newer draft is what comes back", async () => {
    vi.stubGlobal("fetch", fakePayload({ draftStatus: "draft" }).handler);

    const preview = await preflight([trash()]);

    expect(preview.operations[0]?.warning).toBe(
      "The public page at /news/hello goes away as soon as you approve, and links to it will 404. It moves to the trash, where it can be restored as a draft. What comes back is its newest draft, not the page as published now."
    );
  });

  it.each<[string, FakeOptions, JsonObject]>([
    ["already_in_trash", { trashed: true }, {}],
    ["stale_expected_updated_at", {}, { expected_updated_at: "2026-11-01" }],
    ["unknown_collection", {}, { collection: "events" }],
    [
      "trash_not_enabled",
      { collections: [collection("pages", { trash: false })] },
      { collection: "pages" },
    ],
    [
      "drafts_not_enabled",
      { collections: [collection("pages", { drafts: false })] },
      { collection: "pages" },
    ],
    [
      "not_supported",
      {
        collections: [
          collection("media", {
            upload: {
              maxFileSize: null,
              mimeTypes: [],
              urlAllowList: null,
              versions: true,
            },
          }),
        ],
      },
      { collection: "media" },
    ],
    [
      "not_permitted",
      { collections: [collection("pages", { canDelete: false })] },
      { collection: "pages" },
    ],
  ])("refuses with %s", async (code, options, operation) => {
    const fake = fakePayload(options);

    vi.stubGlobal("fetch", fake.handler);

    await expect(preflight([trash(operation)])).rejects.toMatchObject({
      code,
    });
    expect(fake.writes).toHaveLength(0);
  });
});

describe("trash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves deletedAt, as the admin's Delete button does, and never deletes", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([trash()]);

    expect(fake.writes).toStrictEqual([
      {
        body: { deletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) },
        search: "?depth=0",
      },
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["deletedAt"],
      kind: "trash",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "posts/3",
      updated_at: SAVED_AT,
      version_id: "18",
    });

    // The version a trash makes is listed only among trashed ones.
    expect(
      fake.reads.some(
        (read) => read.includes("/versions") && read.includes("trash=true")
      )
    ).toBeTruthy();
  });

  it("writes nothing when the post changed after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([trash()], fake.touch);

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
  });

  it("reports a post another editor has open as locked", async () => {
    vi.stubGlobal("fetch", fakePayload({ locked: true }).handler);

    const [receipt] = await apply([trash()]);

    expect(receipt).toMatchObject({
      error: { code: "locked" },
      status: "conflict",
    });
  });

  it("fails when Payload leaves the post out of the trash", async () => {
    vi.stubGlobal("fetch", fakePayload({ ignoresWrite: true }).handler);

    const [receipt] = await apply([trash()]);

    expect(receipt).toMatchObject({
      changed_paths: [],
      error: { code: "not_trashed" },
      status: "failed",
      updated_at: SAVED_AT,
    });
  });
});

describe("restore from trash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows where the document is and how it comes back", async () => {
    vi.stubGlobal("fetch", fakePayload({ trashed: true }).handler);

    const preview = await preflight([restore()]);

    expect(preview.operations).toStrictEqual([
      {
        editUrl: "https://cms.example/admin/collections/posts/3",
        editor: "Payload admin",
        fields: [
          {
            after: "restored",
            before: `“Hello”, in the trash since ${TRASHED_AT}`,
            changed: true,
            label: "Trash",
            path: "deletedAt",
          },
          {
            after: "draft",
            before: "in the trash",
            changed: true,
            path: "_status",
          },
        ],
        modifiedGmt: READ_AT,
        operationIndex: 0,
        sentence: "Restore posts 3 from the trash as a draft",
        slug: "hello",
        target: "posts/3",
        warning:
          "It comes back as a draft. Its public page stays away until it is published.",
      },
    ]);
  });

  it("says when the page comes back with it", async () => {
    vi.stubGlobal("fetch", fakePayload({ trashed: true }).handler);

    const preview = await preflight([restore({ publish: true })]);

    expect(preview.operations[0]).toMatchObject({
      fields: [{ path: "deletedAt" }, { after: "published", path: "_status" }],
      sentence: "Restore posts 3 from the trash and publish it",
      warning:
        "Its public page comes back as soon as you approve, holding what the document held when it went to the trash.",
    });
  });

  it("is refused for a document that is not in the trash", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(preflight([restore()])).rejects.toMatchObject({
      code: "not_in_trash",
    });
  });

  it("needs update access, not delete access", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({
        collections: [
          collection("pages", { canDelete: false }),
          collection("events", { canUpdate: false }),
        ],
        trashed: true,
      }).handler
    );

    // The stand-in keeps one document, which every collection reads.
    await expect(
      preflight([restore({ collection: "pages" })])
    ).resolves.toMatchObject({ operations: [{ target: "pages/3" }] });

    await expect(
      preflight([restore({ collection: "events" })])
    ).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("restores as a draft in every locale", async () => {
    const fake = fakePayload({ trashed: true });

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restore()]);

    expect(fake.writes).toStrictEqual([
      {
        body: { _status: "draft", deletedAt: null },
        search: "?depth=0&trash=true&unpublishAllLocales=true",
      },
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["deletedAt"],
      details: {
        preview_url: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
      },
      kind: "restore_from_trash",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "posts/3",
      updated_at: SAVED_AT,
      version_id: "18",
    });
  });

  it("restores and publishes in one write", async () => {
    const fake = fakePayload({ trashed: true });

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restore({ publish: true })]);

    expect(fake.writes).toStrictEqual([
      {
        body: { _status: "published", deletedAt: null },
        search: "?depth=0&trash=true&publishAllLocales=true",
      },
    ]);

    expect(receipt).toMatchObject({
      changed_paths: ["_status", "deletedAt"],
      status: "changed",
    });
  });

  it("says when the document came back but was not published", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({ keepsDraft: true, trashed: true }).handler
    );

    const [receipt] = await apply([restore({ publish: true })]);

    expect(receipt).toMatchObject({
      changed_paths: ["deletedAt"],
      error: { code: "not_published" },
      status: "failed",
    });
  });

  it("fails when Payload leaves the post in the trash", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({ ignoresWrite: true, trashed: true }).handler
    );

    const [receipt] = await apply([restore()]);

    expect(receipt).toMatchObject({
      changed_paths: [],
      error: { code: "still_in_trash" },
      status: "failed",
    });
  });
});

const parse = (operation: JsonObject) =>
  parseDraftApplyInput({ intent: "Tidy up", operations: [operation] });

const operation: JsonObject = {
  collection: "posts",
  expected_updated_at: READ_AT,
  id: 3,
  kind: "trash",
};

describe("trash in payload.apply", () => {
  it("takes a collection, an id and what was read", () => {
    expect(parse(operation).operations).toHaveLength(1);
    expect(
      parse({ ...operation, kind: "restore_from_trash", publish: true })
        .operations
    ).toHaveLength(1);
  });

  it.each<[string, JsonObject]>([
    ["no expected_updated_at", { collection: "posts", id: 3, kind: "trash" }],
    ["fields", { ...operation, fields: { title: "x" } }],
    ["publish on a trash", { ...operation, publish: true }],
    [
      "publish: false",
      { ...operation, kind: "restore_from_trash", publish: false },
    ],
  ])("refuses %s", (_name, input) => {
    expect(() => parse(input)).toThrow(/invalid|operations/iu);
  });

  it("refuses to trash and restore one document in one batch", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Tidy up",
        operations: [operation, { ...operation, kind: "restore_from_trash" }],
      })
    ).toThrow(/more than once/u);
  });
});
