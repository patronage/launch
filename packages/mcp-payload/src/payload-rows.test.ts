import {
  ApplyConflictError,
  ApplyValidationError,
  createUpstreamTelemetry,
  NEW_ROW,
  REMOVED_ROW,
} from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  JsonObject,
  JsonValue,
} from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadSiteUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { parseDraftApplyInput } from "./payload-operations";
import type { PayloadOperation, RowChange } from "./payload-operations";
import {
  humanize,
  parseRowFieldPath,
  parseRowPath,
  parseRowsFieldPath,
} from "./payload-row-paths";
import { patchRows, readBackRows } from "./payload-rows";
import type { RowContext, RowConverters } from "./payload-rows";

// What `getEditingInfo` says a page holds: a hero with links, and sections.
const PAGE_ROWS: RowContext = {
  richTextFields: [],
  rowFields: [
    { path: "hero.links", richTextFields: [], rowFields: [], type: "array" },
    {
      blocks: [
        {
          richTextFields: ["body"],
          rowFields: [
            { path: "links", richTextFields: [], rowFields: [], type: "array" },
          ],
          slug: "content",
        },
        {
          richTextFields: [],
          rowFields: [
            {
              path: "cards",
              richTextFields: ["note"],
              rowFields: [],
              type: "array",
            },
          ],
          slug: "cardGrid",
        },
      ],
      path: "layout",
      type: "blocks",
    },
  ],
};

const lexical = (text: string): JsonObject => ({
  root: { children: [{ text, type: "text", version: 1 }], type: "root" },
});

const page = (): JsonObject => ({
  _status: "published",
  hero: { links: [{ id: "h1", label: "Join" }], title: "Welcome" },
  id: 1,
  layout: [
    {
      blockType: "content",
      body: lexical("Old body"),
      heading: "Intro",
      id: "s1",
      links: [],
    },
    {
      blockType: "cardGrid",
      cards: [
        { id: "c1", note: lexical("First"), title: "Seed library" },
        { id: "c2", note: null, title: "Tool share" },
        { id: "c3", note: null, title: "Youth growers" },
      ],
      heading: "Programs",
      id: "s2",
    },
  ],
  slug: "home",
  title: "Home",
  updatedAt: "2026-11-13T10:00:00.000Z",
});

// Markdown as the text of the first node, and back.
const converters: RowConverters = {
  toMarkdown: (_path, value) =>
    Promise.resolve(
      String(
        JSON.stringify(value ?? "").match(/"text":"(?<text>[^"]*)"/u)?.groups
          ?.text ?? ""
      )
    ),
  toRichText: (_path, markdown) => Promise.resolve(lexical(markdown)),
};

const patch = (changes: RowChange[], document = page()) =>
  patchRows(document, PAGE_ROWS, changes, converters);

const rowsSchema = z.array(z.record(z.string(), z.json()));

// The rows of an array or blocks field, as a copy.
const rowsOf = (value: JsonValue | undefined): JsonObject[] =>
  rowsSchema.parse(value ?? []);

const cards = (document: JsonObject): JsonObject[] =>
  rowsOf(rowsOf(document.layout)[1]?.cards);

describe("row paths", () => {
  it("takes a path apart into names and rows", () => {
    expect(parseRowPath("layout[id=s2].cards[id=c1].title")).toStrictEqual([
      { name: "layout" },
      { rowId: "s2" },
      { name: "cards" },
      { rowId: "c1" },
      { name: "title" },
    ]);

    expect(parseRowPath("hero.links")).toStrictEqual([
      { name: "hero" },
      { name: "links" },
    ]);
  });

  it.each([
    "",
    "layout[id=s2]..title",
    "layout[0].title",
    "layout[id=].title",
    "layout[id=a b].title",
    "layout[id=s2][id=c1].title",
    "layout[id=s2].__proto__",
    "layout[id=s2].id",
    "layout[id=s2].blockType",
    "9layout[id=s2].title",
    "a[id=1].b[id=2].c[id=3].d[id=4].e[id=5].f",
  ])("refuses %j", (path) => {
    expect(() => parseRowPath(path)).toThrow(ApplyValidationError);
  });

  it("tells a row's field from a rows field", () => {
    expect(() => parseRowFieldPath("title")).toThrow("names no row");
    expect(() => parseRowFieldPath("layout[id=s2]")).toThrow("ends at a row");
    expect(() => parseRowsFieldPath("layout[id=s2]")).toThrow("ends at a row");
    expect(parseRowsFieldPath("layout[id=s2].cards")).toHaveLength(3);
  });

  it("reads a name the way a person would", () => {
    expect(humanize("cardGrid")).toBe("Card grid");
    expect(humanize("sectionOptions")).toBe("Section options");
    expect(humanize("call_to_action")).toBe("Call to action");
  });
});

describe(patchRows, () => {
  it("sets one field of one row and leaves every other row alone", async () => {
    const before = page();

    const result = await patch(
      [{ op: "set", path: "layout[id=s2].cards[id=c2].title", value: "Tools" }],
      before
    );

    expect(result.snapshots).toStrictEqual([
      {
        after: "Tools",
        before: "Tool share",
        changed: true,
        label: "Layout › Card grid (row 2) › Cards › row 2 › Title",
        path: "layout[id=s2].cards[id=c2].title",
      },
    ]);

    expect(result.touched).toStrictEqual(["layout"]);
    expect(cards(result.working)[1]).toStrictEqual({
      id: "c2",
      note: null,
      title: "Tools",
    });

    // The document that was read is not changed, and neither are the rows
    // the change did not name.
    expect(before).toStrictEqual(page());
    expect(cards(result.working)[0]).toStrictEqual(cards(before)[0]);
  });

  it("reaches rows inside a group", async () => {
    const result = await patch([
      { op: "set", path: "hero.links[id=h1].label", value: "Join us" },
    ]);

    expect(result.touched).toStrictEqual(["hero"]);
    expect(result.snapshots[0]?.label).toBe("Hero › Links › row 1 › Label");
    expect(result.working.hero).toStrictEqual({
      links: [{ id: "h1", label: "Join us" }],
      title: "Welcome",
    });
  });

  it("writes a row's rich text as Markdown", async () => {
    const result = await patch([
      { markdown: "New body", op: "set_markdown", path: "layout[id=s1].body" },
      {
        markdown: "First",
        op: "set_markdown",
        path: "layout[id=s2].cards[id=c1].note",
      },
    ]);

    expect(result.snapshots.map((field) => field.changed)).toStrictEqual([
      true,
      false,
    ]);

    expect(result.snapshots[0]).toMatchObject({
      after: "New body",
      before: "Old body",
      label: "Layout › Content (row 1) › Body",
    });

    expect(rowsOf(result.working.layout)[0]?.body).toStrictEqual(
      lexical("New body")
    );
  });

  it("puts a row in, first or after another", async () => {
    const result = await patch([
      {
        after_id: "c1",
        field: "layout[id=s2].cards",
        op: "insert",
        row: { title: "Compost club" },
      },
      {
        after_id: null,
        field: "layout",
        op: "insert",
        row: { blockType: "content", heading: "Notice" },
      },
    ]);

    expect(result.snapshots).toStrictEqual([
      {
        after: '{"title":"Compost club"}',
        before: NEW_ROW,
        changed: true,
        label: "Layout › Card grid (row 2) › Cards › new row 2",
        path: "layout[id=s2].cards[new]",
      },
      {
        after: '{"blockType":"content","heading":"Notice"}',
        before: NEW_ROW,
        changed: true,
        label: "Layout › new row 1",
        path: "layout[new]",
      },
    ]);

    const layout = rowsOf(result.working.layout);

    expect(layout.map((row) => row.id)).toStrictEqual([undefined, "s1", "s2"]);
    expect(
      cards({ layout: layout.slice(1) }).map((row) => row.title)
    ).toStrictEqual([
      "Seed library",
      "Compost club",
      "Tool share",
      "Youth growers",
    ]);
  });

  it("takes a row out and moves another", async () => {
    const result = await patch([
      { field: "layout[id=s2].cards", op: "remove", row_id: "c1" },
      {
        after_id: null,
        field: "layout[id=s2].cards",
        op: "move",
        row_id: "c3",
      },
    ]);

    expect(result.snapshots).toStrictEqual([
      {
        after: REMOVED_ROW,
        before:
          '{"note":{"root":{"children":[{"text":"First","type":"text","version":1}],"type":"root"}},"title":"Seed library"}',
        changed: true,
        label: "Layout › Card grid (row 2) › Cards › row 1",
        path: "layout[id=s2].cards[id=c1]",
      },
      {
        after: "position 1 of 2",
        before: "position 2 of 2",
        changed: true,
        label: "Layout › Card grid (row 2) › Cards › row 2",
        path: "layout[id=s2].cards[id=c3]",
      },
    ]);

    expect(cards(result.working).map((row) => row.id)).toStrictEqual([
      "c3",
      "c2",
    ]);
  });

  it("touches nothing when nothing differs", async () => {
    const result = await patch([
      { op: "set", path: "layout[id=s1].heading", value: "Intro" },
      {
        after_id: "c1",
        field: "layout[id=s2].cards",
        op: "move",
        row_id: "c2",
      },
    ]);

    expect(result.touched).toStrictEqual([]);
    expect(result.snapshots.map((field) => field.changed)).toStrictEqual([
      false,
      false,
    ]);
  });

  it.each<[string, RowChange]>([
    ["unknown_row", { op: "set", path: "layout[id=nope].heading", value: "x" }],
    ["not_a_rows_field", { op: "set", path: "title[id=s1].x", value: "x" }],
    ["use_set_markdown", { op: "set", path: "layout[id=s1].body", value: "x" }],
    ["rows_field", { op: "set", path: "layout[id=s2].cards", value: [] }],
    [
      "not_rich_text",
      { markdown: "x", op: "set_markdown", path: "layout[id=s1].heading" },
    ],
    [
      "unknown_block_type",
      { after_id: null, field: "layout", op: "insert", row: { heading: "x" } },
    ],
    [
      "unknown_block_type",
      {
        after_id: null,
        field: "layout",
        op: "insert",
        row: { blockType: "quote", text: "x" },
      },
    ],
    [
      "unknown_row",
      {
        after_id: "nope",
        field: "layout[id=s2].cards",
        op: "insert",
        row: { title: "x" },
      },
    ],
    ["unknown_row", { field: "layout", op: "remove", row_id: "nope" }],
    ["not_a_rows_field", { field: "title", op: "remove", row_id: "s1" }],
  ])("refuses with %s", async (code, change) => {
    await expect(patch([change])).rejects.toMatchObject({ code });
    await expect(patch([change])).rejects.toBeInstanceOf(ApplyConflictError);
  });
});

describe(readBackRows, () => {
  it("reports what landed, what Payload rewrote and what it dropped", async () => {
    const result = await patch([
      { op: "set", path: "layout[id=s1].heading", value: "Hello" },
      { op: "set", path: "layout[id=s2].heading", value: "  Our programs " },
      { op: "set", path: "layout[id=s2].cards[id=c1].unknown", value: 1 },
      {
        after_id: "c3",
        field: "layout[id=s2].cards",
        op: "insert",
        row: { title: "Compost club" },
      },
    ]);

    // As Payload stored it: one heading trimmed, the unknown field dropped,
    // and the new row given an id and its defaults.
    const [intro = {}, grid = {}] = rowsOf(result.working.layout);

    const stored = rowsOf(grid.cards).map((card, index) => {
      const { unknown: _dropped, ...kept } = card;

      return index === 3 ? { ...kept, id: "c9", note: null } : kept;
    });

    const after: JsonObject = {
      ...result.working,
      layout: [intro, { ...grid, cards: stored, heading: "Our programs" }],
    };

    expect(readBackRows(result, after, PAGE_ROWS)).toStrictEqual({
      changed: [
        "layout[id=s1].heading",
        "layout[id=s2].heading",
        "layout[id=s2].cards[new]",
      ],
      inserted: ["c9"],
      missed: ["layout[id=s2].cards[id=c1].unknown"],
      normalized: ["layout[id=s2].heading"],
    });
  });

  it("misses a row that was not put where it was asked", async () => {
    const result = await patch([
      {
        after_id: null,
        field: "layout[id=s2].cards",
        op: "move",
        row_id: "c3",
      },
    ]);

    expect(readBackRows(result, page(), PAGE_ROWS)).toMatchObject({
      changed: [],
      missed: ["layout[id=s2].cards[id=c3]"],
    });
  });
});

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

const INFO = {
  collections: [
    {
      canCreate: true,
      canUpdate: true,
      drafts: true,
      richTextFields: ["content"],
      rowFields: PAGE_ROWS.rowFields,
      slug: "pages",
    },
  ],
};

// A Payload stand-in with one page. It stores what it is sent, gives new
// rows an id, and answers the two rich text tools the way `converters` does.
const fakePayload = () => {
  const bodies: JsonObject[] = [];
  const tools: JsonObject[] = [];
  let stored = page();
  let nextId = 100;

  const withRowIds = (rows: JsonObject[]): JsonObject[] =>
    rows.map((row) => ({ ...row, id: row.id ?? `n${(nextId += 1)}` }));

  const withIds = (value: JsonObject): JsonObject => ({
    ...value,
    layout: withRowIds(rowsOf(value.layout)).map((row) => {
      const copy: JsonObject = { ...row };

      if (row.cards !== undefined) {
        copy.cards = withRowIds(rowsOf(row.cards));
      }

      return copy;
    }),
  });

  const tool = async (rpc: {
    params: { arguments: JsonObject; name: string };
  }) => {
    const { arguments: args, name } = rpc.params;

    tools.push({ name, ...args });

    if (name === "getEditingInfo") {
      return { content: [], structuredContent: INFO };
    }

    if (name === "markdownToRichText") {
      return {
        content: [],
        structuredContent: { value: lexical(String(args.markdown)) },
      };
    }

    return {
      content: [],
      structuredContent: {
        lost: [],
        markdown: await converters.toMarkdown([], args.value),
      },
    };
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/api/mcp") {
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: await tool(await request.json()),
      });
    }

    if (url.pathname.endsWith("/versions")) {
      return Response.json({
        docs: [{ id: 41, version: { updatedAt: stored.updatedAt } }],
      });
    }

    if (request.method === "PATCH") {
      const body: JsonObject = await request.json();

      bodies.push(body);

      stored = withIds({
        ...stored,
        ...body,
        updatedAt: "2026-11-13T11:00:00.000Z",
      });

      return Response.json({ doc: stored });
    }

    return Response.json(stored);
  };

  return {
    bodies,
    handler,
    // Another editor saves the page between the preview and the write.
    touch: () => {
      stored = { ...stored, updatedAt: "2026-11-13T10:30:00.000Z" };
    },
    tools,
  };
};

const patchPage = (
  changes: RowChange[],
  extra: { expected_updated_at?: string; publish?: true } = {}
): PayloadOperation => ({
  changes,
  collection: "pages",
  expected_updated_at: "2026-11-13T10:00:00.000Z",
  id: 1,
  kind: "patch_rows",
  ...extra,
});

const preflight = (operations: PayloadOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Update the home page",
    operations,
    (collection, id) =>
      `https://cms.example/admin/collections/${collection}/${id}`,
    createUpstreamTelemetry()
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

const retitle: RowChange = {
  op: "set",
  path: "layout[id=s2].cards[id=c2].title",
  value: "Tools",
};

describe("patch_rows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows each change for approval", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([patchPage([retitle], { publish: true })]);
    const [operation] = preview.operations;

    expect(operation).toMatchObject({
      editUrl: "https://cms.example/admin/collections/pages/1",
      modifiedGmt: "2026-11-13T10:00:00.000Z",
      sentence: "Save 1 row change in layout to pages 1 and publish it",
      slug: "home",
      target: "pages/1",
    });

    expect(operation?.fields.map((field) => field.path)).toStrictEqual([
      "layout[id=s2].cards[id=c2].title",
      "_status",
    ]);
  });

  it("refuses a page that changed since it was read", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight([
        patchPage([retitle], { expected_updated_at: "2026-11-01T00:00:00Z" }),
      ])
    ).rejects.toMatchObject({ code: "stale_expected_updated_at" });
  });

  it("sends only the fields that hold the changed rows, as a draft", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([patchPage([retitle])]);
    const [body] = fake.bodies;

    expect(Object.keys(body ?? {})).toStrictEqual(["layout"]);
    expect(cards(body ?? {}).map((row) => row.title)).toStrictEqual([
      "Seed library",
      "Tools",
      "Youth growers",
    ]);

    expect(receipt).toStrictEqual({
      changed_paths: ["layout[id=s2].cards[id=c2].title"],
      kind: "patch_rows",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "pages/1",
      updated_at: "2026-11-13T11:00:00.000Z",
      version_id: "41",
    });
  });

  it("converts a row's Markdown with the nested field's path", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([
      patchPage([
        {
          markdown: "Second",
          op: "set_markdown",
          path: "layout[id=s2].cards[id=c1].note",
        },
      ]),
    ]);

    expect(receipt?.status).toBe("changed");

    expect(
      fake.tools.find((call) => call.name === "markdownToRichText")
    ).toStrictEqual({
      field: "note",
      markdown: "Second",
      name: "markdownToRichText",
      path: ["layout", "cardGrid", "cards", "note"],
      slug: "pages",
    });
  });

  it("reports the ids Payload gave new rows", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const [receipt] = await apply([
      patchPage([
        {
          after_id: "c3",
          field: "layout[id=s2].cards",
          op: "insert",
          row: { title: "Compost club" },
        },
      ]),
    ]);

    expect(receipt).toMatchObject({
      changed_paths: ["layout[id=s2].cards[new]"],
      details: { inserted_row_ids: "n101" },
      status: "changed",
    });
  });

  it("sends nothing for a change that is none", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([
      patchPage([{ op: "set", path: "layout[id=s1].heading", value: "Intro" }]),
    ]);

    expect(fake.bodies).toHaveLength(0);
    expect(receipt).toMatchObject({ changed_paths: [], status: "unchanged" });
  });

  it("writes nothing when the page changed after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([patchPage([retitle])], fake.touch);

    expect(fake.bodies).toHaveLength(0);
    expect(receipt).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
  });
});

const parse = (operation: JsonObject) =>
  parseDraftApplyInput({ intent: "Update the page", operations: [operation] });

const rowsOperation = (changes: JsonObject[]): JsonObject => ({
  changes,
  collection: "pages",
  expected_updated_at: "2026-11-13T10:00:00.000Z",
  id: 1,
  kind: "patch_rows",
});

describe("patch_rows in payload.apply", () => {
  it("takes each kind of change", () => {
    expect(
      parse(
        rowsOperation([
          { op: "set", path: "layout[id=s1].heading", value: "Hello" },
          { markdown: "Hi", op: "set_markdown", path: "layout[id=s1].body" },
          {
            after_id: null,
            field: "layout",
            op: "insert",
            row: { blockType: "content" },
          },
          { field: "layout", op: "remove", row_id: "s2" },
          { after_id: "s1", field: "layout", op: "move", row_id: "s3" },
        ])
      ).operations
    ).toHaveLength(1);
  });

  it.each<[string, JsonObject[]]>([
    ["no changes", []],
    ["a path with no row", [{ op: "set", path: "title", value: "x" }]],
    [
      "a path outside the grammar",
      [{ op: "set", path: "layout[0].title", value: "x" }],
    ],
    [
      "the same field twice",
      [
        { op: "set", path: "layout[id=s1].heading", value: "a" },
        { op: "set", path: "layout[id=s1].heading", value: "b" },
      ],
    ],
    [
      "a row removed and moved",
      [
        { field: "layout", op: "remove", row_id: "s1" },
        { after_id: null, field: "layout", op: "move", row_id: "s1" },
      ],
    ],
    [
      "a row moved after itself",
      [{ after_id: "s1", field: "layout", op: "move", row_id: "s1" }],
    ],
    [
      "a new row with an id",
      [{ after_id: null, field: "layout", op: "insert", row: { id: "x" } }],
    ],
    [
      "an empty new row",
      [{ after_id: null, field: "layout", op: "insert", row: {} }],
    ],
  ])("refuses %s", (_what, changes) => {
    expect(() => parse(rowsOperation(changes))).toThrow(ApplyValidationError);
  });

  it("refuses row changes that do not say what they read", () => {
    const { expected_updated_at: _stamp, ...operation } = rowsOperation([
      { op: "set", path: "layout[id=s1].heading", value: "x" },
    ]);

    expect(() => parse(operation)).toThrow(ApplyValidationError);
  });

  it("refuses a second operation on the same document", () => {
    expect(() =>
      parseDraftApplyInput({
        intent: "Update the page",
        operations: [
          rowsOperation([
            { op: "set", path: "layout[id=s1].heading", value: "x" },
          ]),
          {
            collection: "pages",
            fields: { title: "x" },
            id: 1,
            kind: "update_draft",
          },
        ],
      })
    ).toThrow("more than once");
  });
});
