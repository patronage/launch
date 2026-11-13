import { createUpstreamTelemetry } from "@patronage/mcp-core";
import type { ApplyPreflight, JsonObject } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadGlobalAdminUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { NO_DRAFTS_WARNING } from "./payload-global-apply";
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

// Two globals: site settings without drafts, and a footer that keeps drafts
// and holds a list of links. `locked` names the globals another editor has
// open, or is undefined for a Payload whose `getEditingInfo` does not say.
const editingInfo = (locked: Set<string> | undefined) => ({
  collections: [],
  globals: [
    {
      canUpdate: true,
      drafts: false,
      richTextFields: [],
      slug: "site-settings",
    },
    {
      canUpdate: true,
      drafts: true,
      richTextFields: [],
      rowFields: [
        { path: "links", richTextFields: [], rowFields: [], type: "array" },
      ],
      slug: "footer",
    },
    { canUpdate: false, drafts: true, richTextFields: [], slug: "legal" },
  ].map((global) =>
    locked ? { ...global, locked: locked.has(global.slug) } : global
  ),
});

const globals = (): Map<string, JsonObject> =>
  new Map<string, JsonObject>(
    Object.entries({
      footer: {
        _status: "draft",
        links: [
          { id: "l1", label: "About", url: "/about" },
          { id: "l2", label: "Contact", url: "/contact" },
        ],
        note: "Made by neighbors",
        updatedAt: READ_AT,
      },
      legal: { _status: "published", updatedAt: READ_AT },
      "site-settings": {
        siteName: "Neighborhood Growers",
        tagline: "Grow food together",
        updatedAt: READ_AT,
      },
    })
  );

interface Write {
  body: JsonObject;
  draft: boolean;
  slug: string;
}

const rowsSchema = z.array(z.record(z.string(), z.json()));

// A Payload stand-in for globals. It stores what it is sent, gives new rows
// an id, and answers a write the way Payload does: `{ message, result }`.
const fakePayload = (
  options: { refusesSave?: boolean; reportsLocks?: boolean } = {}
) => {
  const stored = globals();
  const locked = new Set<string>();
  const writes: Write[] = [];
  let nextId = 100;

  const withRowIds = (value: JsonObject): JsonObject => {
    const rows = rowsSchema.safeParse(value.links);

    return rows.success
      ? {
          ...value,
          links: rows.data.map((row) => ({
            ...row,
            id: row.id ?? `n${(nextId += 1)}`,
          })),
        }
      : value;
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/api/mcp") {
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: {
          content: [],
          structuredContent: editingInfo(
            options.reportsLocks === false ? undefined : locked
          ),
        },
      });
    }

    // /api/globals/<slug>, or /api/globals/<slug>/versions
    const segments = url.pathname.split("/");
    const slug = segments.at(3) ?? "";
    const current = stored.get(slug);

    if (segments.at(4) === "versions") {
      return Response.json({
        docs: [{ id: 7, version: { updatedAt: current?.updatedAt } }],
      });
    }

    if (request.method !== "POST") {
      return Response.json(current ?? {}, { status: current ? 200 : 404 });
    }

    if (options.refusesSave) {
      return Response.json(
        { errors: [{ message: "Locked" }] },
        { status: 423 }
      );
    }

    const body: JsonObject = await request.json();

    writes.push({
      body,
      draft: url.searchParams.get("draft") === "true",
      slug,
    });

    const saved = withRowIds({ ...current, ...body, updatedAt: SAVED_AT });

    stored.set(slug, saved);

    return Response.json({ message: "Saved", result: saved });
  };

  return {
    handler,
    // Another editor opens a global in the admin.
    lock: (slug: string) => {
      locked.add(slug);
    },
    stored,
    // Another editor saves a global between the preview and the write.
    touch: (slug: string) => {
      stored.set(slug, {
        ...stored.get(slug),
        updatedAt: "2026-11-13T10:30:00.000Z",
      });
    },
    writes,
  };
};

type GlobalFields = Omit<
  Extract<PayloadOperation, { kind: "update_global" }>,
  "expected_updated_at" | "global" | "kind"
> & { expected_updated_at?: string };

const updateGlobal = (
  global: string,
  rest: GlobalFields
): PayloadOperation => ({
  expected_updated_at: READ_AT,
  global,
  kind: "update_global",
  ...rest,
});

const preflight = (operations: PayloadOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Update the site",
    operations,
    () => "",
    createUpstreamTelemetry(),
    { globalAdminUrl: (slug) => payloadGlobalAdminUrl(env, slug) }
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
    telemetry: createUpstreamTelemetry(),
  });

  return receipt.operations;
};

const tagline = { fields: { tagline: "Grow food, block by block" } };

describe("update_global on a global without drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is refused unless the operation says it publishes", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    await expect(
      preflight([updateGlobal("site-settings", tagline)])
    ).rejects.toMatchObject({ code: "publish_required" });
    expect(fake.writes).toHaveLength(0);
  });

  it("previews the change with a warning that it is live at once", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([
      updateGlobal("site-settings", { ...tagline, publish: true }),
    ]);

    expect(preview.operations).toStrictEqual([
      {
        editUrl: "https://cms.example/admin/globals/site-settings",
        editor: "Payload admin",
        fields: [
          {
            after: "Grow food, block by block",
            before: "Grow food together",
            changed: true,
            path: "tagline",
          },
        ],
        modifiedGmt: READ_AT,
        operationIndex: 0,
        sentence: "Save tagline to the site-settings global and publish it",
        slug: "site-settings",
        target: "globals/site-settings",
        warning: NO_DRAFTS_WARNING,
      },
    ]);
  });

  it("saves only the fields that differ, without a draft or a status", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([
      updateGlobal("site-settings", {
        fields: {
          siteName: "Neighborhood Growers",
          tagline: "Grow food, block by block",
        },
        publish: true,
      }),
    ]);

    expect(fake.writes).toStrictEqual([
      {
        body: { tagline: "Grow food, block by block" },
        draft: false,
        slug: "site-settings",
      },
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["tagline"],
      kind: "update_global",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "globals/site-settings",
      updated_at: SAVED_AT,
      version_id: "7",
    });
  });

  it("sends nothing when every field is already as asked", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([
      updateGlobal("site-settings", {
        fields: { tagline: "Grow food together" },
        publish: true,
      }),
    ]);

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({ status: "unchanged", updated_at: READ_AT });
  });

  it("refuses a global that changed since it was read", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight([
        updateGlobal("site-settings", {
          ...tagline,
          expected_updated_at: "2026-11-01T00:00:00.000Z",
          publish: true,
        }),
      ])
    ).rejects.toMatchObject({ code: "stale_expected_updated_at" });
  });

  it("writes nothing when the global changed after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply(
      [updateGlobal("site-settings", { ...tagline, publish: true })],
      () => fake.touch("site-settings")
    );

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
  });

  it("refuses a global another editor has open before anyone is asked", async () => {
    const fake = fakePayload();

    fake.lock("site-settings");
    vi.stubGlobal("fetch", fake.handler);

    await expect(
      preflight([updateGlobal("site-settings", { ...tagline, publish: true })])
    ).rejects.toMatchObject({
      code: "locked",
      message:
        "globals/site-settings is open in the Payload admin for another editor; try again once they have finished",
    });
    expect(fake.writes).toHaveLength(0);
  });

  it("leaves a global alone when another editor opens it after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply(
      [updateGlobal("site-settings", { ...tagline, publish: true })],
      () => fake.lock("site-settings")
    );

    expect(fake.writes).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "locked" },
      status: "conflict",
    });
  });

  it("is refused when the site's Payload does not report editor locks", async () => {
    const fake = fakePayload({ reportsLocks: false });

    vi.stubGlobal("fetch", fake.handler);

    await expect(
      preflight([updateGlobal("site-settings", { ...tagline, publish: true })])
    ).rejects.toMatchObject({ code: "lock_unknown" });
    expect(fake.writes).toHaveLength(0);
  });

  it("reports a save Payload refuses as locked", async () => {
    vi.stubGlobal("fetch", fakePayload({ refusesSave: true }).handler);

    const [receipt] = await apply([
      updateGlobal("site-settings", { ...tagline, publish: true }),
    ]);

    expect(receipt).toMatchObject({
      error: { code: "locked" },
      status: "conflict",
    });
  });
});

const addLink = {
  after_id: "l2",
  field: "links",
  op: "insert",
  row: { label: "Join", url: "/join" },
} as const;

describe("update_global on a global with drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves fields and row changes as one draft", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const operation = updateGlobal("footer", {
      changes: [
        { op: "set", path: "links[id=l1].label", value: "About us" },
        addLink,
      ],
      fields: { note: "Made by neighbors, for neighbors" },
    });

    const preview = await preflight([operation]);
    const [receipt] = await apply([operation]);

    expect(preview.operations[0]).toMatchObject({
      sentence:
        "Save note and 2 row changes in links as a draft of the footer global",
    });
    expect(preview.operations[0]?.warning).toBeUndefined();

    expect(fake.writes).toMatchObject([
      {
        body: {
          links: [
            { id: "l1", label: "About us" },
            { id: "l2" },
            { label: "Join", url: "/join" },
          ],
          note: "Made by neighbors, for neighbors",
        },
        draft: true,
        slug: "footer",
      },
    ]);

    expect(receipt).toMatchObject({
      changed_paths: ["note", "links[id=l1].label", "links[new]"],
      details: { inserted_row_ids: "n101" },
      status: "changed",
      version_id: "7",
    });
  });

  it("publishes with a status row, and reports the status as changed", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const operation = updateGlobal("footer", { publish: true });
    const preview = await preflight([operation]);
    const [receipt] = await apply([operation]);

    expect(preview.operations[0]).toMatchObject({
      fields: [{ after: "published", changed: true, path: "_status" }],
      sentence: "Publish the footer global",
    });

    expect(fake.writes).toStrictEqual([
      { body: { _status: "published" }, draft: false, slug: "footer" },
    ]);

    expect(receipt).toMatchObject({
      changed_paths: ["_status"],
      status: "changed",
    });
  });

  it("refuses a global the editor cannot update, or cannot read", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight([updateGlobal("legal", { fields: { body: "x" } })])
    ).rejects.toMatchObject({ code: "not_permitted" });

    await expect(
      preflight([updateGlobal("navigation", { fields: { body: "x" } })])
    ).rejects.toMatchObject({ code: "unknown_global" });
  });

  it("refuses a row the global does not hold", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight([
        updateGlobal("footer", {
          changes: [{ field: "links", op: "remove", row_id: "gone" }],
        }),
      ])
    ).rejects.toMatchObject({ code: "unknown_row" });
  });
});

const parse = (operation: JsonObject) =>
  parseDraftApplyInput({ intent: "Update the site", operations: [operation] });

const global = (rest: JsonObject): JsonObject => ({
  expected_updated_at: READ_AT,
  global: "footer",
  kind: "update_global",
  ...rest,
});

describe("update_global in payload.apply", () => {
  it("takes fields, row changes, or a publish alone", () => {
    expect(parse(global({ fields: { note: "x" } })).operations).toHaveLength(1);
    expect(parse(global({ changes: [addLink] })).operations).toHaveLength(1);
    expect(parse(global({ publish: true })).operations).toHaveLength(1);
  });

  it.each<[string, JsonObject]>([
    ["nothing to change", global({})],
    [
      "no expected_updated_at",
      { global: "footer", kind: "update_global", publish: true },
    ],
    ["a field Payload manages", global({ fields: { updatedAt: "x" } })],
    ["a status in fields", global({ fields: { _status: "published" } })],
    ["Markdown fields", global({ markdown: { note: "x" } })],
    [
      "Markdown in a row",
      global({
        changes: [
          { markdown: "x", op: "set_markdown", path: "links[id=l1].note" },
        ],
      }),
    ],
    [
      "a field that is in both fields and changes",
      global({ changes: [addLink], fields: { links: [] } }),
    ],
    [
      "a path outside the grammar",
      global({ changes: [{ ...addLink, field: "links[0]" }] }),
    ],
  ])("refuses %s", (_name, operation) => {
    expect(() => parse(operation)).toThrow(/invalid|operations/iu);
  });

  it("refuses the same global twice in one batch", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Update the site",
        operations: [
          global({ fields: { note: "a" } }),
          global({ fields: { note: "b" } }),
        ],
      })
    ).toThrow(/more than once/u);
  });
});
