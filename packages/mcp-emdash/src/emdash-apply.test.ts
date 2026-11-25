import {
  ApplyConflictError,
  ApplyValidationError,
  createCallerScope,
  createUpstreamTelemetry,
} from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  BatchReceipt,
  JsonObject,
  JsonValue,
  RuntimeStore,
} from "@patronage/mcp-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createEmDashTools } from "./emdash-tools";
import type { EmDashEnv } from "./env";
import { emdashConnector } from "./gateway";

const caller = { subjectOpaque: "editor0000000000", token: "editor-jwt" };

interface FakeEntry {
  data: JsonObject;
  draft?: JsonObject | undefined;
  id: string;
  slug: string;
  status: string;
  version: number;
}

interface Sent {
  body: JsonValue;
  method: string;
  path: string;
}

const recordSchema = z.record(z.string(), z.json());

const ok = (data: JsonValue, status = 200) =>
  Response.json({ data, success: true }, { status });

const refuse = (code: string, message: string, status: number) =>
  Response.json({ error: { code, message } }, { status });

const rev = (entry: FakeEntry) => `rev-${entry.id}-${entry.version}`;

const view = (entry: FakeEntry): JsonObject => {
  const item: JsonObject = {
    data: { ...entry.data, ...entry.draft },
    draftRevisionId: entry.draft ? `draft-${entry.version}` : null,
    id: entry.id,
    slug: entry.slug,
    status: entry.status,
    updatedAt: `2026-11-25T00:00:0${entry.version}.000Z`,
  };

  if (entry.draft) {
    item.liveData = entry.data;
  }

  return { _rev: rev(entry), item };
};

interface FakeOptions {
  // Answers the next write with this EmDash error instead of saving.
  refuseWrite?: { code: string; message: string; status: number };
  // A field EmDash keeps as it was, as a hook might.
  ignoreField?: string;
}

// An EmDash Worker stand-in that keeps entries and applies saves the way
// EmDash 1.6 does on a collection with revisions: a save stages a draft and
// advances the version, a publish makes the draft live.
const fakeEmDash = (options: FakeOptions = {}) => {
  const entries = new Map<string, FakeEntry>([
    [
      "news/01N",
      {
        data: { body: [], excerpt: "Old excerpt", title: "Old title" },
        id: "01N",
        slug: "compost",
        status: "published",
        version: 2,
      },
    ],
  ]);

  const sent: Sent[] = [];

  const schemas = new Map([
    ["news", ["revisions", "drafts"]],
    ["menus_like", ["drafts"]],
  ]);

  const answer = (method: string, path: string, body: JsonObject) => {
    // /_emdash/api/{kind}/{collection}/{id}/{action}
    const [kind, collection = "", id = "", action = ""] = path
      .split("/")
      .slice(3);

    if (kind === "schema") {
      // /_emdash/api/schema/collections/{slug}
      const supports = schemas.get(id);

      return supports
        ? ok({
            item: {
              fields: [
                { slug: "title" },
                { slug: "excerpt" },
                { slug: "body" },
              ],
              supports,
            },
          })
        : refuse("NOT_FOUND", `Collection not found: ${id}`, 404);
    }

    if (method === "POST" && id === "") {
      const created: FakeEntry = {
        data: recordSchema.parse(body.data),
        id: "01NEW",
        slug: String(body.slug ?? "untitled"),
        status: "draft",
        version: 1,
      };

      entries.set(`${collection}/${created.id}`, created);

      return ok(view(created), 201);
    }

    const entry =
      entries.get(`${collection}/${id}`) ??
      [...entries.values()].find((candidate) => candidate.slug === id);

    if (!entry) {
      return refuse("NOT_FOUND", `Content item not found: ${id}`, 404);
    }

    if (method === "GET") {
      return ok(view(entry));
    }

    if (action === "preview-url") {
      return ok({ expiresAt: 0, url: `/news/${entry.slug}?_preview=signed` });
    }

    if (options.refuseWrite) {
      const { code, message, status } = options.refuseWrite;

      return refuse(code, message, status);
    }

    if (body._rev !== rev(entry)) {
      return refuse("CONFLICT", "Content has been modified", 409);
    }

    if (action === "publish") {
      entry.data = { ...entry.data, ...entry.draft };
      entry.draft = undefined;
      entry.status = "published";
    } else {
      const data = Object.fromEntries(
        Object.entries(recordSchema.parse(body.data)).filter(
          ([key]) => key !== options.ignoreField
        )
      );

      entry.draft = { ...entry.draft, ...data };
    }

    entry.version += 1;

    return ok(view(entry));
  };

  const fetcher = {
    connect: vi.fn<Fetcher["connect"]>(),
    fetch: vi.fn<Fetcher["fetch"]>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      const body: JsonObject = init?.body ? JSON.parse(String(init.body)) : {};

      if (method !== "GET") {
        sent.push({ body, method, path: url.pathname });
      }

      return await Promise.resolve(answer(method, url.pathname, body));
    }),
  } satisfies Fetcher;

  const env: EmDashEnv = {
    EMDASH: fetcher,
    EMDASH_ACCESS_PROOF_SECRET: "proof-secret",
    EMDASH_ADMIN_URL: "https://site.example",
  };

  return { entries, env, sent };
};

const memoryStore = (): RuntimeStore => ({
  readPreflight: () => Promise.resolve(undefined),
  readRequester: () => Promise.resolve("requester0000000"),
  writePreflight: () => Promise.resolve(),
});

const preflight = (env: EmDashEnv, args: JsonObject) =>
  emdashConnector.preflight(env, caller, args, createUpstreamTelemetry());

// The approved replay: the stored preview rides on the caller, as the
// runtime passes it after a person approves.
const apply = async (
  env: EmDashEnv,
  args: JsonObject,
  approved: ApplyPreflight
): Promise<BatchReceipt> => {
  const scope = createCallerScope();

  const tools = createEmDashTools({
    env,
    scope,
    store: memoryStore(),
    telemetry: () => createUpstreamTelemetry(),
  });

  return await scope.run(
    { ...caller, executionId: "exec-1", preflight: approved },
    () => tools.apply.execute(args)
  );
};

const updateTitle = (fields?: JsonObject) => ({
  intent: "Fix the headline",
  operations: [
    {
      collection: "news",
      expected_rev: "rev-01N-2",
      fields: fields ?? { title: "New title" },
      id: "01N",
      kind: "update_draft",
    },
  ],
});

describe("emdash update_draft", () => {
  it("previews the change with admin and preview links, then saves a draft against the previewed rev", async () => {
    const { entries, env, sent } = fakeEmDash();
    const args = updateTitle();
    const approved = await preflight(env, args);

    expect(approved.operations[0]).toMatchObject({
      editUrl: "https://site.example/_emdash/admin/content/news/01N",
      fields: [
        {
          after: "New title",
          before: "Old title",
          changed: true,
          path: "title",
        },
      ],
      modifiedGmt: "rev-01N-2",
      previewUrl: "https://site.example/news/compost?_preview=signed",
      slug: "compost",
      target: "news/01N",
    });

    const receipt = await apply(env, args, approved);

    expect(receipt.status).toBe("succeeded");
    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["title"],
      details: { id: "01N", rev: "rev-01N-3", status: "published" },
      status: "changed",
    });
    expect(sent.at(-1)).toStrictEqual({
      body: { _rev: "rev-01N-2", data: { title: "New title" } },
      method: "PUT",
      path: "/_emdash/api/content/news/01N",
    });
    // The live entry is untouched; only the draft has the new title.
    expect(entries.get("news/01N")?.data.title).toBe("Old title");
  });

  it("stops with a conflict when the entry changed after the preview, writing nothing", async () => {
    const { entries, env, sent } = fakeEmDash();
    const args = updateTitle();
    const approved = await preflight(env, args);
    const entry = entries.get("news/01N");

    if (entry) {
      entry.version += 1;
    }

    const receipt = await apply(env, args, approved);

    expect(receipt.operations[0]).toMatchObject({
      error: { code: "CONFLICT" },
      status: "conflict",
    });
    expect(sent.filter((request) => request.method === "PUT")).toHaveLength(0);
  });

  it.each([
    ["CONFLICT", 409, "conflict"],
    ["ENTRY_LOCKED", 409, "conflict"],
    ["FORBIDDEN", 403, "failed"],
  ])(
    "reports EmDash's %s (HTTP %i) on the write as %s",
    async (code, status, receiptStatus) => {
      const { env } = fakeEmDash();
      const args = updateTitle();
      const approved = await preflight(env, args);

      const refused = fakeEmDash({
        refuseWrite: { code, message: "Refused by EmDash", status },
      });

      const receipt = await apply(refused.env, args, approved);

      expect(receipt.operations[0]).toMatchObject({
        error: { code, message: `EmDash ${code}: Refused by EmDash` },
        status: receiptStatus,
      });
    }
  );

  it("fails the receipt when EmDash kept a field as it was", async () => {
    const { env } = fakeEmDash({ ignoreField: "excerpt" });
    const args = updateTitle({ excerpt: "New excerpt", title: "New title" });
    const receipt = await apply(env, args, await preflight(env, args));

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["title"],
      error: {
        code: "readback_mismatch",
        message: "EmDash did not store excerpt",
      },
      status: "failed",
    });
  });

  it("writes nothing without a stored preview", async () => {
    const { env, sent } = fakeEmDash();

    const receipt = await apply(env, updateTitle(), {
      intent: "x",
      operations: [],
    });

    expect(receipt.operations[0]?.error?.code).toBe("missing_preflight");
    expect(sent).toHaveLength(0);
  });

  it.each([
    [
      "a stale expected_rev",
      updateTitle(),
      (entries: Map<string, FakeEntry>) => {
        const entry = entries.get("news/01N");

        if (entry) {
          entry.version = 5;
        }
      },
      "stale_expected_rev",
    ],
    [
      "a field the collection doesn't have",
      updateTitle({ subtitle: "x" }),
      () => {},
      "unknown_field",
    ],
    [
      "a slug in place of the id",
      {
        intent: "x",
        operations: [
          {
            collection: "news",
            fields: { title: "x" },
            id: "compost",
            kind: "update_draft",
          },
        ],
      },
      () => {},
      "not_an_entry_id",
    ],
    [
      "a collection without revisions",
      {
        intent: "x",
        operations: [
          {
            collection: "menus_like",
            fields: { title: "x" },
            id: "01N",
            kind: "update_draft",
          },
        ],
      },
      () => {},
      "no_draft_revisions",
    ],
  ])("refuses to preview %s", async (_name, args, change, code) => {
    const { entries, env } = fakeEmDash();

    change(entries);

    await expect(preflight(env, args)).rejects.toThrow(
      expect.objectContaining({ code })
    );
    await expect(preflight(env, args)).rejects.toBeInstanceOf(
      ApplyConflictError
    );
  });
});

describe("emdash create_draft", () => {
  it("creates a draft entry and reports its id", async () => {
    const { env, sent } = fakeEmDash();

    const args = {
      intent: "Add a story",
      operations: [
        {
          collection: "news",
          fields: { title: "Seed swap" },
          kind: "create_draft",
          slug: "seed-swap",
        },
      ],
    };

    const approved = await preflight(env, args);

    expect(approved.operations[0]).toMatchObject({
      fields: [{ after: "Seed swap", changed: true, path: "title" }],
      target: "news (new #1)",
    });

    const receipt = await apply(env, args, approved);

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["title"],
      details: {
        edit_url: "https://site.example/_emdash/admin/content/news/01NEW",
        id: "01NEW",
        status: "draft",
      },
      status: "changed",
    });
    expect(sent.at(-1)).toStrictEqual({
      body: {
        data: { title: "Seed swap" },
        slug: "seed-swap",
        status: "draft",
      },
      method: "POST",
      path: "/_emdash/api/content/news",
    });
  });
});

const publish = (expectedRev: string) => ({
  intent: "Publish the fix",
  operations: [
    {
      collection: "news",
      expected_rev: expectedRev,
      id: "01N",
      kind: "publish",
    },
  ],
});

describe("emdash publish", () => {
  it("refuses a published entry with no draft", async () => {
    const { env } = fakeEmDash();

    await expect(preflight(env, publish("rev-01N-2"))).rejects.toThrow(
      expect.objectContaining({ code: "nothing_to_publish" })
    );
  });

  it("previews what goes live with a warning, then publishes the draft", async () => {
    const { entries, env } = fakeEmDash();
    const save = updateTitle();

    await apply(env, save, await preflight(env, save));

    const args = publish("rev-01N-3");
    const approved = await preflight(env, args);

    expect(approved.operations[0]).toMatchObject({
      fields: [
        {
          after: "New title",
          before: "Old title",
          changed: true,
          path: "title",
        },
      ],
      warning: expect.stringContaining("public site"),
    });

    const receipt = await apply(env, args, approved);

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["title"],
      details: { rev: "rev-01N-4", status: "published" },
      status: "changed",
    });
    expect(entries.get("news/01N")?.data.title).toBe("New title");
  });
});

describe("emdash apply validation", () => {
  it.each([
    [
      "the same entry twice",
      [
        {
          collection: "news",
          fields: { title: "a" },
          id: "01N",
          kind: "update_draft",
        },
        { collection: "news", id: "01N", kind: "publish" },
      ],
      "duplicate_target",
    ],
    [
      "a field EmDash keeps for itself",
      [
        {
          collection: "news",
          fields: { _slug: "x" },
          id: "01N",
          kind: "update_draft",
        },
      ],
      "invalid_operations",
    ],
    [
      "a key EmDash would write live",
      [
        {
          collection: "news",
          fields: { title: "a" },
          id: "01N",
          kind: "update_draft",
          taxonomies: { category: ["x"] },
        },
      ],
      "invalid_operations",
    ],
    [
      "an id outside the path pattern",
      [
        {
          collection: "news",
          fields: { title: "a" },
          id: "../users",
          kind: "update_draft",
        },
      ],
      "invalid_operations",
    ],
  ])("refuses %s", (_name, operations, code) => {
    expect(() =>
      emdashConnector.parseApply({ intent: "x", operations })
    ).toThrow(expect.objectContaining({ code }));
    expect(() =>
      emdashConnector.parseApply({ intent: "x", operations })
    ).toThrow(ApplyValidationError);
  });

  it("names each operation for the paused result", () => {
    expect(
      emdashConnector.parseApply({
        intent: "Fix and add",
        operations: [
          {
            collection: "news",
            fields: { title: "a" },
            id: "01N",
            kind: "update_draft",
          },
          { collection: "news", fields: { title: "b" }, kind: "create_draft" },
          { collection: "pages", id: "01P", kind: "publish" },
        ],
      }).sentences
    ).toStrictEqual([
      "Save title on news 01N as a draft",
      "Create a news draft with title (news (new #2))",
      "Publish pages 01P",
    ]);
  });
});
