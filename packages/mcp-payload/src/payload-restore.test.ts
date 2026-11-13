import { createUpstreamTelemetry } from "@patronage/mcp-core";
import type { ApplyPreflight, JsonObject } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PayloadEnv } from "./env";
import {
  createPayloadClient,
  payloadGlobalAdminUrl,
  payloadSiteUrl,
} from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { NO_DRAFTS_WARNING } from "./payload-global-apply";
import { parseDraftApplyInput } from "./payload-operations";
import type { PayloadOperation } from "./payload-operations";
import { LOCALES_WARNING } from "./payload-restore-apply";

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

const OLD_AT = "2026-11-12T09:00:00.000Z";
const READ_AT = "2026-11-13T10:00:00.000Z";
const RESTORED_AT = "2026-11-13T11:00:00.000Z";
const PUBLISHED_AT = "2026-11-13T11:00:01.000Z";

const richText = (text: string): JsonObject => ({
  root: { children: [{ text, type: "text" }], type: "root" },
});

// The post as it stands: published once as "Hello", with a newer draft.
const CURRENT_POST: JsonObject = {
  _status: "draft",
  content: richText("The new body"),
  id: 3,
  layout: [
    { blockType: "content", id: "a", title: "Now" },
    { blockType: "content", id: "b", title: "Added since" },
  ],
  slug: "hello",
  title: "Hello again",
  updatedAt: READ_AT,
  updatedBy: { relationTo: "users", value: 2 },
};

// Version 10 of it: what was published the day before.
const OLD_POST: JsonObject = {
  _status: "published",
  content: richText("The first body"),
  layout: [
    { blockType: "content", id: "a", title: "Then" },
    { blockType: "content", id: "c", title: "Removed since" },
  ],
  slug: "hello",
  title: "Hello",
  updatedAt: OLD_AT,
  updatedBy: { relationTo: "users", value: 1 },
};

const POSTS = {
  canCreate: true,
  canUpdate: true,
  drafts: true,
  preview: true,
  richTextFields: ["content"],
  rowFields: [{ blocks: [], path: "layout", type: "blocks" }],
  slug: "posts",
};

interface FakeOptions {
  // Collections beside posts.
  collections?: JsonObject[];
  // A Payload without the `getDocumentLock` tool.
  noLockTool?: boolean;
  // Payload refuses to publish what was restored.
  publishRefused?: boolean;
  // The first read after a publish fails; the publish itself went through.
  readFailsAfterPublish?: boolean;
  // Another editor saves the target right after the restore lands.
  savedAfterRestore?: boolean;
}

interface Write {
  body: JsonObject;
  method: string;
  path: string;
  search: string;
}

// A Payload stand-in with one post and two globals: site settings without
// drafts, and a footer that keeps them. A restore gives the target the
// version's fields, as a draft when it is asked to.
const fakePayload = (options: FakeOptions = {}) => {
  const writes: Write[] = [];
  const locked = new Set<string>();
  let failNextRead = false;

  const stored = new Map<string, JsonObject>(
    Object.entries({
      "globals/footer": {
        _status: "published",
        note: "Made by neighbors",
        updatedAt: READ_AT,
      },
      "globals/site-settings": {
        tagline: "Grow food together",
        updatedAt: READ_AT,
      },
      "posts/3": CURRENT_POST,
    })
  );

  // Each version by its id: whose it is, and what it holds.
  const versions = new Map<string, { owner: string; version: JsonObject }>(
    Object.entries({
      "10": { owner: "posts/3", version: OLD_POST },
      "11": { owner: "posts/4", version: OLD_POST },
      "12": {
        owner: "posts/3",
        version: { ...CURRENT_POST, updatedAt: OLD_AT },
      },
      "20": {
        owner: "globals/site-settings",
        version: { tagline: "Seeds for everyone", updatedAt: OLD_AT },
      },
      "21": {
        owner: "globals/footer",
        version: {
          _status: "draft",
          note: "Made by the block",
          updatedAt: OLD_AT,
        },
      },
    })
  );

  const info = () => ({
    collections: [POSTS, ...(options.collections ?? [])],
    globals: [
      {
        canUpdate: true,
        drafts: false,
        locked: locked.has("globals/site-settings"),
        richTextFields: [],
        slug: "site-settings",
      },
      {
        canUpdate: true,
        drafts: true,
        locked: false,
        richTextFields: [],
        slug: "footer",
      },
    ],
  });

  const tools = (rpc: {
    params: { arguments: { value?: { root?: { children?: JsonObject[] } } } };
  }) => ({
    getDocumentLock: options.noLockTool
      ? { content: [{ text: "Tool not found", type: "text" }], isError: true }
      : { content: [], structuredContent: { locked: locked.has("posts/3") } },
    getEditingInfo: { content: [], structuredContent: info() },
    getPreviewUrl: {
      content: [],
      structuredContent: {
        path: "/news/hello",
        url: "/next/preview?path=%2Fnews%2Fhello",
      },
    },
    richTextToMarkdown: {
      content: [],
      structuredContent: {
        lost: ["block"],
        markdown: String(
          rpc.params.arguments.value?.root?.children?.at(0)?.text ?? ""
        ),
      },
    },
  });

  const tool = (
    rpc: Parameters<typeof tools>[0] & { params: { name: string } }
  ) =>
    new Map<string, JsonObject>(Object.entries(tools(rpc))).get(
      rpc.params.name
    );

  const restore = (
    owner: string,
    version: JsonObject,
    asDraft: boolean
  ): JsonObject => {
    const restored: JsonObject = {
      ...version,
      id: stored.get(owner)?.id ?? 1,
      updatedAt: RESTORED_AT,
    };

    if (asDraft) {
      restored._status = "draft";
    }

    stored.set(
      owner,
      options.savedAfterRestore
        ? {
            ...restored,
            title: "Theirs",
            updatedAt: "2026-11-13T12:00:30.000Z",
          }
        : restored
    );

    return restored;
  };

  const publish = (owner: string): Response => {
    if (options.publishRefused) {
      return Response.json(
        {
          errors: [{ message: "You are not allowed to perform this action." }],
        },
        { status: 403 }
      );
    }

    const published = {
      ...stored.get(owner),
      _status: "published",
      updatedAt: PUBLISHED_AT,
    };

    stored.set(owner, published);
    failNextRead = options.readFailsAfterPublish === true;

    return Response.json(
      owner.startsWith("globals/") ? { result: published } : { doc: published }
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

    // /api/posts/3, /api/posts/versions[/10], /api/globals/footer,
    // /api/globals/footer/versions[/21]
    const segments = url.pathname.split("/").slice(2);
    const at = segments.indexOf("versions");
    const isGlobal = segments.at(0) === "globals";

    const owner = isGlobal
      ? `globals/${segments.at(1)}`
      : `posts/${at === -1 ? segments.at(1) : "3"}`;

    if (at !== -1 && segments.length === at + 1) {
      return Response.json({
        docs: [
          { id: 30, version: { updatedAt: stored.get(owner)?.updatedAt } },
        ],
      });
    }

    const found = at === -1 ? undefined : versions.get(segments.at(-1) ?? "");

    if (at !== -1 && request.method === "GET") {
      if (!found) {
        return Response.json(
          { errors: [{ message: "Not Found" }] },
          { status: 404 }
        );
      }

      const answer: JsonObject = {
        id: Number(segments.at(-1)),
        version: found.version,
      };

      // A document's version names its document; a global's does not.
      if (!isGlobal) {
        answer.parent = Number(found.owner.split("/").at(1));
      }

      return Response.json(answer);
    }

    if (request.method === "GET" && failNextRead) {
      failNextRead = false;

      return Response.json({ errors: [{ message: "Busy" }] }, { status: 500 });
    }

    if (request.method === "GET") {
      return Response.json(stored.get(owner) ?? {}, {
        status: stored.has(owner) ? 200 : 404,
      });
    }

    writes.push({
      body: await request.json(),
      method: request.method,
      path: url.pathname,
      search: url.search,
    });

    if (!found) {
      return publish(owner);
    }

    const restored = restore(
      found.owner,
      found.version,
      url.searchParams.get("draft") === "true"
    );

    return Response.json(
      isGlobal
        ? { doc: restored, message: "Restored Successfully." }
        : { ...restored, message: "Restored Successfully." }
    );
  };

  return {
    handler,
    // Another editor opens the target in the admin.
    lock: (owner: string) => {
      locked.add(owner);
    },
    stored,
    // Another editor saves the post between the preview and the write.
    touch: () => {
      stored.set("posts/3", {
        ...CURRENT_POST,
        updatedAt: "2026-11-13T10:30:00.000Z",
      });
    },
    writes,
  };
};

const restorePost = (rest: JsonObject = {}): PayloadOperation => ({
  collection: "posts",
  expected_updated_at: READ_AT,
  id: 3,
  kind: "restore_version",
  version_id: 10,
  ...rest,
});

const restoreGlobal = (
  global: string,
  rest: JsonObject = {}
): PayloadOperation => ({
  expected_updated_at: READ_AT,
  global,
  kind: "restore_global_version",
  version_id: global === "footer" ? 21 : 20,
  ...rest,
});

const preflight = (operations: PayloadOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Bring back yesterday's version",
    operations,
    (slug, id) => `https://cms.example/admin/collections/${slug}/${id}`,
    createUpstreamTelemetry(),
    {
      globalAdminUrl: (slug) => payloadGlobalAdminUrl(env, slug),
      siteUrl: (link) => payloadSiteUrl(env, link),
    }
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

describe("restore_version preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the version and each field it changes", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([restorePost()]);

    expect(preview.operations).toStrictEqual([
      {
        editUrl: "https://cms.example/admin/collections/posts/3",
        editor: "Payload admin",
        fields: [
          {
            after: `version 10, saved ${OLD_AT}, published`,
            before: `saved ${READ_AT}, draft`,
            changed: true,
            label: "Version",
            path: "(version)",
          },
          // Rich text reads as Markdown, even where Markdown loses a node.
          {
            after: "The first body",
            before: "The new body",
            changed: true,
            path: "content",
          },
          // Rows are counted, by id.
          {
            after:
              "2 rows: 1 not in the current draft, 1 of the current ones gone, 1 changed",
            before: "2 rows",
            changed: true,
            path: "layout",
          },
          {
            after: "Hello",
            before: "Hello again",
            changed: true,
            path: "title",
          },
        ],
        modifiedGmt: READ_AT,
        operationIndex: 0,
        previewUrl: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
        sentence: "Restore posts 3 to version 10 as a draft",
        slug: "hello",
        target: "posts/3",
      },
    ]);
  });

  it("warns that a restore brings back every locale", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({
        collections: [{ ...POSTS, localized: true, slug: "pages" }],
      }).handler
    );

    // The stand-in keeps one document, which every collection reads.
    const preview = await preflight([restorePost({ collection: "pages" })]);

    expect(preview.operations[0]?.warning).toBe(LOCALES_WARNING);
  });

  it("restores a version that matches in the one locale it can read", async () => {
    const fake = fakePayload({
      collections: [{ ...POSTS, localized: true, slug: "pages" }],
    });

    vi.stubGlobal("fetch", fake.handler);

    // Version 12 holds what the document holds, in this locale.
    const operation = restorePost({ collection: "pages", version_id: 12 });

    await expect(preflight([operation])).resolves.toMatchObject({
      operations: [{ warning: LOCALES_WARNING }],
    });

    const [receipt] = await apply([operation]);

    expect(fake.writes).toHaveLength(1);
    expect(receipt).toMatchObject({ changed_paths: [], status: "changed" });
  });

  it("adds the status row when the operation publishes", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([restorePost({ publish: true })]);
    const [operation] = preview.operations;

    expect(operation?.sentence).toBe(
      "Restore posts 3 to version 10 and publish it"
    );
    expect(operation?.fields.at(-1)).toStrictEqual({
      after: "published",
      before: "draft",
      changed: true,
      path: "_status",
    });
  });

  it.each<[string, JsonObject, FakeOptions]>([
    ["stale_expected_updated_at", { expected_updated_at: OLD_AT }, {}],
    ["unknown_version", { version_id: 99 }, {}],
    ["version_of_another_document", { version_id: 11 }, {}],
    ["nothing_to_restore", { version_id: 12 }, {}],
    ["lock_unknown", {}, { noLockTool: true }],
    [
      "drafts_not_enabled",
      { collection: "authors" },
      { collections: [{ ...POSTS, drafts: false, slug: "authors" }] },
    ],
    [
      "not_permitted",
      { collection: "pages" },
      { collections: [{ ...POSTS, canUpdate: false, slug: "pages" }] },
    ],
    [
      "not_supported",
      { collection: "files" },
      {
        collections: [
          {
            ...POSTS,
            slug: "files",
            upload: {
              maxFileSize: null,
              mimeTypes: [],
              urlAllowList: null,
              versions: true,
            },
          },
        ],
      },
    ],
  ])("refuses with %s before anyone is asked", async (code, rest, options) => {
    const fake = fakePayload(options);

    vi.stubGlobal("fetch", fake.handler);

    await expect(preflight([restorePost(rest)])).rejects.toMatchObject({
      code,
    });
    expect(fake.writes).toHaveLength(0);
  });

  it("refuses a document another editor has open", async () => {
    const fake = fakePayload();

    fake.lock("posts/3");
    vi.stubGlobal("fetch", fake.handler);

    await expect(preflight([restorePost()])).rejects.toMatchObject({
      code: "locked",
    });
  });
});

describe("restore_version write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores as a draft and reports what changed", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost()]);

    expect(fake.writes).toStrictEqual([
      {
        body: {},
        method: "POST",
        path: "/api/posts/versions/10",
        search: "?depth=0&draft=true",
      },
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["content", "layout", "title"],
      details: {
        preview_url: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
        restored_version_id: "10",
      },
      kind: "restore_version",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "posts/3",
      updated_at: RESTORED_AT,
      version_id: "30",
    });
  });

  it("publishes in a second write, never by restoring without the draft flag", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost({ publish: true })]);

    expect(fake.writes).toStrictEqual([
      {
        body: {},
        method: "POST",
        path: "/api/posts/versions/10",
        search: "?depth=0&draft=true",
      },
      {
        body: { _status: "published" },
        method: "PATCH",
        path: "/api/posts/3",
        search: "?depth=0&publishAllLocales=true",
      },
    ]);

    expect(receipt).toMatchObject({
      changed_paths: ["content", "layout", "title", "_status"],
      status: "changed",
      updated_at: PUBLISHED_AT,
    });
  });

  it("says when the restored draft could not be published", async () => {
    const fake = fakePayload({ publishRefused: true });

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost({ publish: true })]);

    expect(receipt).toMatchObject({
      changed_paths: ["content", "layout", "title"],
      error: {
        code: "not_published",
        message:
          "Payload restored posts/3 as a draft but did not publish it: Payload: You are not allowed to perform this action.",
      },
      status: "failed",
      updated_at: RESTORED_AT,
    });
  });

  it("keeps a publish that went through when the read after it fails once", async () => {
    const fake = fakePayload({ readFailsAfterPublish: true });

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost({ publish: true })]);

    expect(receipt).toMatchObject({
      changed_paths: ["content", "layout", "title", "_status"],
      status: "changed",
      updated_at: PUBLISHED_AT,
    });
    expect(receipt).not.toHaveProperty("error");
  });

  it("leaves a draft another editor saved since unpublished", async () => {
    const fake = fakePayload({ savedAfterRestore: true });

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost({ publish: true })]);

    expect(fake.writes.map((write) => write.method)).toStrictEqual(["POST"]);
    expect(receipt).toMatchObject({
      error: {
        code: "not_published",
        message:
          "Payload restored posts/3 as a draft but did not publish it: posts/3 was saved again right after the restore",
      },
      status: "failed",
    });
  });

  it("writes nothing when the document changed after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost()], fake.touch);

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
  });

  it("writes nothing when another editor opens the document after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([restorePost()], () => fake.lock("posts/3"));

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "locked" },
      status: "conflict",
    });
  });
});

describe("restore_global_version", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is refused for a global without drafts unless it says it publishes", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight([restoreGlobal("site-settings")])
    ).rejects.toMatchObject({ code: "publish_required" });
  });

  it("warns that a global without drafts is live at once, and restores it", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const operations = [restoreGlobal("site-settings", { publish: true })];
    const preview = await preflight(operations);

    expect(preview.operations[0]).toMatchObject({
      editUrl: "https://cms.example/admin/globals/site-settings",
      sentence: "Restore the site-settings global to version 20 and publish it",
      target: "globals/site-settings",
      warning: NO_DRAFTS_WARNING,
    });

    const [receipt] = await apply(operations);

    expect(fake.writes).toStrictEqual([
      {
        body: {},
        method: "POST",
        path: "/api/globals/site-settings/versions/20",
        search: "?depth=0",
      },
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["tagline"],
      details: { restored_version_id: "20" },
      kind: "restore_global_version",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "globals/site-settings",
      updated_at: RESTORED_AT,
      version_id: "30",
    });
  });

  it("refuses a global another editor has open", async () => {
    const fake = fakePayload();

    fake.lock("globals/site-settings");
    vi.stubGlobal("fetch", fake.handler);

    await expect(
      preflight([restoreGlobal("site-settings", { publish: true })])
    ).rejects.toMatchObject({ code: "locked" });
  });

  it("restores a global with drafts as a draft, and publishes it when asked", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [draft] = await apply([restoreGlobal("footer")]);

    expect(draft).toMatchObject({ changed_paths: ["note"], status: "changed" });
    expect(fake.stored.get("globals/footer")).toMatchObject({
      _status: "draft",
      note: "Made by the block",
    });

    fake.stored.set("globals/footer", {
      _status: "published",
      note: "Made by neighbors",
      updatedAt: READ_AT,
    });

    const [published] = await apply([
      restoreGlobal("footer", { publish: true }),
    ]);

    expect(
      fake.writes.map((write) => `${write.method} ${write.path}${write.search}`)
    ).toStrictEqual([
      "POST /api/globals/footer/versions/21?depth=0&draft=true",
      "POST /api/globals/footer/versions/21?depth=0&draft=true",
      "POST /api/globals/footer?depth=0&publishAllLocales=true",
    ]);
    expect(published).toMatchObject({
      changed_paths: ["note"],
      status: "changed",
      updated_at: PUBLISHED_AT,
    });
  });
});

describe("restore operations in payload.apply's input", () => {
  it("needs expected_updated_at and a version", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Bring back yesterday's version",
        operations: [{ collection: "posts", id: 3, kind: "restore_version" }],
      })
    ).toThrow(/expected_updated_at.*version_id/u);
  });

  it("takes one restore per document", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Bring back yesterday's version",
        operations: [restorePost(), restorePost({ version_id: 12 })],
      })
    ).toThrow("batch addresses posts/3 more than once");
  });
});
