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
import { editingInfoSchema } from "./payload-editing";
import type { EditingInfo } from "./payload-editing";
import { payloadConnector } from "./payload-gateway";
import type { DraftOperation } from "./payload-operations";
import {
  createTitleLookup,
  MAX_TITLE_LOOKUPS,
  relationPreview,
} from "./payload-relations";

const env: PayloadEnv = {
  PAYLOAD_ACCESS_PROOF_SECRET: "proof-secret",
  PAYLOAD_ADMIN_URL: "https://cms.example",
  PAYLOAD_API_URL: "https://payload.example",
};

const caller = { subjectOpaque: "editor0000000000", token: "editor-jwt" };
const client = () => createPayloadClient(env, caller);
const siteUrl = (link: string) => payloadSiteUrl(env, link);

const adminUrl = (collection: string, id: number | string) =>
  `https://cms.example/admin/collections/${collection}/${id}`;

// What apps/payload's `getEditingInfo` answers today.
const INFO = {
  collections: [
    {
      autosave: true,
      canCreate: true,
      canDelete: false,
      canUpdate: true,
      drafts: true,
      localized: false,
      preview: true,
      relationFields: [
        { hasMany: false, path: "hero", relationTo: ["media"] },
        { hasMany: true, path: "authors", relationTo: ["authors"] },
        { hasMany: false, path: "link", relationTo: ["pages", "posts"] },
        { hasMany: false, path: "updatedBy", relationTo: ["users"] },
      ],
      richTextFields: ["content"],
      rowFields: [
        {
          blocks: [
            {
              richTextFields: ["body"],
              rowFields: [
                {
                  path: "links",
                  richTextFields: [],
                  rowFields: [],
                  type: "array",
                },
              ],
              slug: "content",
            },
          ],
          path: "layout",
          type: "blocks",
        },
      ],
      schedulePublish: false,
      slug: "posts",
      titleField: "title",
      trash: false,
    },
    {
      autosave: false,
      canCreate: true,
      canDelete: true,
      canUpdate: true,
      drafts: false,
      localized: false,
      preview: false,
      relationFields: [],
      richTextFields: [],
      rowFields: [],
      schedulePublish: false,
      slug: "media",
      titleField: "filename",
      trash: false,
      upload: {
        maxFileSize: null,
        mimeTypes: ["image/*"],
        urlAllowList: [{ hostname: "images.example", protocol: "https" }],
        versions: true,
      },
    },
    {
      canCreate: true,
      canUpdate: true,
      drafts: false,
      richTextFields: [],
      slug: "authors",
      titleField: "name",
    },
  ],
  globals: [
    {
      canUpdate: true,
      drafts: false,
      localized: false,
      relationFields: [],
      richTextFields: [],
      rowFields: [],
      slug: "site-settings",
    },
  ],
  localization: null,
} satisfies JsonObject;

// The schema `@patronage/mcp-payload` 0.2 read `getEditingInfo` with.
const firstVersionSchema = z.object({
  collections: z.array(
    z.object({
      canCreate: z.boolean(),
      canUpdate: z.boolean(),
      drafts: z.boolean(),
      richTextFields: z.array(z.string()),
      slug: z.string(),
    })
  ),
});

describe("getEditingInfo", () => {
  it("reads rows, uploads, globals and the absence of locales", () => {
    const info = editingInfoSchema.parse(INFO);
    const [posts, media] = info.collections;

    expect(posts?.rowFields[0]?.blocks?.[0]?.rowFields[0]?.path).toBe("links");
    expect(media?.upload?.urlAllowList).toStrictEqual([
      { hostname: "images.example", protocol: "https" },
    ]);
    expect(info.globals.map((global) => global.slug)).toStrictEqual([
      "site-settings",
    ]);
    expect(info.localization).toBeNull();
  });

  it("reads a site with locales", () => {
    const info = editingInfoSchema.parse({
      ...INFO,
      localization: { defaultLocale: "en", locales: ["en", "es"] },
    });

    expect(info.localization?.locales).toStrictEqual(["en", "es"]);
  });

  it("reads the first version, with nothing new to write to", () => {
    const info = editingInfoSchema.parse({
      collections: [
        {
          canCreate: true,
          canUpdate: true,
          drafts: true,
          richTextFields: ["content"],
          slug: "posts",
        },
      ],
    });

    expect(info.collections[0]).toMatchObject({
      canDelete: false,
      preview: false,
      relationFields: [],
      rowFields: [],
      trash: false,
    });
    expect(info.collections[0]?.upload).toBeUndefined();
    expect(info.globals).toStrictEqual([]);
    expect(info.localization).toBeNull();
  });

  it("still answers what the 0.2 gateway reads", () => {
    const old = firstVersionSchema.parse(INFO);

    expect(old.collections[0]).toStrictEqual({
      canCreate: true,
      canUpdate: true,
      drafts: true,
      richTextFields: ["content"],
      slug: "posts",
    });
  });
});

describe(payloadSiteUrl, () => {
  it("makes a path on the site absolute", () => {
    expect(siteUrl("/next/preview?path=%2Fnews%2Fhello")).toBe(
      "https://cms.example/next/preview?path=%2Fnews%2Fhello"
    );
  });

  it("drops a link that leaves the site, or has no site to join", () => {
    expect(siteUrl("https://elsewhere.example/next/preview")).toBe("");
    expect(siteUrl("//elsewhere.example/next/preview")).toBe("");
    expect(siteUrl("")).toBe("");
    expect(payloadSiteUrl({ PAYLOAD_ACCESS_PROOF_SECRET: "x" }, "/a")).toBe("");
  });
});

interface FakeOptions {
  // Payload answers the versions query with its newest version, whatever
  // time was asked for.
  ignoreVersionFilter?: boolean;
  locked?: boolean;
  // Another editor saves the post right after the approved write.
  overtaken?: boolean;
  previewUrl?: string | null;
}

// A Payload stand-in: one draft post, two authors, one media file, and the
// version each write makes.
const fakePayload = (options: FakeOptions = {}) => {
  const paths: string[] = [];

  let post: JsonObject = {
    _status: "draft",
    authors: [3],
    hero: null,
    id: 12,
    slug: "hello",
    title: "Old title",
    updatedAt: "2026-11-13T10:00:00.000Z",
  };

  const created: JsonObject = {
    _status: "draft",
    id: 34,
    title: "New post",
    updatedAt: "2026-11-13T12:00:00.000Z",
  };

  const versions: { id: number; updatedAt: string }[] = [];

  const others = new Map<string, JsonObject>([
    ["/api/authors/3", { id: 3, name: "Ada Okafor" }],
    ["/api/authors/5", { id: 5, name: "Ben Silva" }],
    ["/api/media/7", { filename: "raised-beds.jpg", id: 7 }],
    ["/api/posts/34", created],
  ]);

  const tool = (name: string) => {
    if (name === "getEditingInfo") {
      return { content: [], structuredContent: INFO };
    }

    return {
      content: [],
      structuredContent: {
        url:
          options.previewUrl === undefined
            ? "/next/preview?path=%2Fnews%2Fhello"
            : options.previewUrl,
      },
    };
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : await request.text();

    paths.push(`${request.method} ${url.pathname}`);

    if (url.pathname === "/api/mcp") {
      const rpc = JSON.parse(body);

      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: tool(rpc.params.name),
      });
    }

    if (url.pathname.endsWith("/versions")) {
      const stamp = url.searchParams.get("where[version.updatedAt][equals]");

      const found = options.ignoreVersionFilter
        ? versions.slice(-1)
        : versions.filter((version) => version.updatedAt === stamp);

      return Response.json({
        docs: found.map(({ id, updatedAt }) => ({
          id,
          version: { updatedAt },
        })),
      });
    }

    if (request.method === "PATCH" && options.locked) {
      return Response.json(
        { errors: [{ message: "Document is currently locked." }] },
        { status: 423 }
      );
    }

    if (request.method === "PATCH") {
      const doc = {
        ...post,
        ...JSON.parse(body),
        updatedAt: "2026-11-13T11:00:00.000Z",
      };

      post = doc;
      versions.push({ id: 91, updatedAt: doc.updatedAt });

      if (options.overtaken) {
        post = { ...doc, updatedAt: "2026-11-13T11:00:05.000Z" };
        versions.push({ id: 92, updatedAt: "2026-11-13T11:00:05.000Z" });
      }

      return Response.json({ doc });
    }

    if (request.method === "POST") {
      versions.push({ id: 77, updatedAt: "2026-11-13T12:00:00.000Z" });

      return Response.json({ doc: created });
    }

    const found =
      url.pathname === "/api/posts/12" ? post : others.get(url.pathname);

    return found
      ? Response.json(found)
      : Response.json({ errors: [{ message: "Not Found" }] }, { status: 404 });
  };

  return { handler, paths };
};

const update: DraftOperation = {
  collection: "posts",
  fields: { authors: [3, 5], hero: 7, title: "New title" },
  id: 12,
  kind: "update_draft",
};

const preflight = (operations: DraftOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Update the post",
    operations,
    adminUrl,
    createUpstreamTelemetry(),
    { siteUrl }
  );

const apply = async (operations: DraftOperation[]) => {
  const approved = await preflight(operations);

  const receipt = await applyDraftOperations({
    approverOpaque: "approver00000000",
    client: client(),
    executionId: "exec_1",
    operations,
    preflight: approved,
    requesterOpaque: "requester0000000",
    siteUrl,
    telemetry: createUpstreamTelemetry(),
  });

  return receipt.operations;
};

describe("the approval preview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names related documents by title and files by filename", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([update]);
    const [operation] = preview.operations;

    const fields = new Map(
      operation?.fields.map((field) => [field.path, field])
    );

    expect(fields.get("authors")).toMatchObject({
      after: "Ada Okafor (authors 3), Ben Silva (authors 5)",
      before: "Ada Okafor (authors 3)",
      changed: true,
    });
    expect(fields.get("hero")).toMatchObject({
      after: "raised-beds.jpg (media 7)",
      before: "",
    });
    expect(fields.get("title")?.after).toBe("New title");
  });

  it("offers the front end's draft preview beside the admin link", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([update]);
    const [operation] = preview.operations;

    expect(operation?.editUrl).toBe(
      "https://cms.example/admin/collections/posts/12"
    );
    expect(operation?.previewUrl).toBe(
      "https://cms.example/next/preview?path=%2Fnews%2Fhello"
    );
  });

  it.each([
    ["has no address yet", null],
    ["points off the site", "https://elsewhere.example/steal"],
  ])("offers no preview when the document %s", async (_case, previewUrl) => {
    vi.stubGlobal("fetch", fakePayload({ previewUrl }).handler);

    const preview = await preflight([update]);
    const [operation] = preview.operations;

    expect(operation).toBeDefined();
    expect(operation).not.toHaveProperty("previewUrl");
  });
});

describe(relationPreview, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const info: EditingInfo = editingInfoSchema.parse(INFO);

  const lookup = () =>
    createTitleLookup(client(), info, createUpstreamTelemetry());

  it("shows the id alone for a collection Payload did not describe", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    await expect(
      relationPreview(lookup(), { path: "updatedBy", relationTo: ["users"] }, 1)
    ).resolves.toBe("users 1");
    expect(fake.paths).toStrictEqual([]);
  });

  it("shows the id alone for a document it cannot read", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      relationPreview(lookup(), { path: "hero", relationTo: ["media"] }, 99)
    ).resolves.toBe("media 99");
  });

  it("reads a field that takes more than one collection", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const field = { path: "link", relationTo: ["pages", "posts"] };

    await expect(
      relationPreview(lookup(), field, { relationTo: "posts", value: 34 })
    ).resolves.toBe("New post (posts 34)");
    // A bare id does not say which collection it is in.
    await expect(relationPreview(lookup(), field, 34)).resolves.toBe("34");
  });

  it("shows a value in a shape it does not know as stored", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const field = { path: "hero", relationTo: ["media"] };

    await expect(
      relationPreview(lookup(), field, { id: 7, filename: "populated.jpg" })
    ).resolves.toBe('{"id":7,"filename":"populated.jpg"}');
    await expect(relationPreview(lookup(), field, null)).resolves.toBe("");
  });

  it("reads each document once and stops at the limit", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const titles = lookup();
    const field = { path: "authors", relationTo: ["authors"] };
    const ids = Array.from({ length: MAX_TITLE_LOOKUPS + 20 }, (_, id) => id);

    // Eight at a time is as many as one value names.
    for (let start = 0; start < ids.length; start += 8) {
      // oxlint-disable-next-line no-await-in-loop -- one value after another, as a preview reads them.
      await relationPreview(titles, field, ids.slice(start, start + 8));
    }

    await relationPreview(titles, field, [3, 3]);

    expect(fake.paths).toHaveLength(MAX_TITLE_LOOKUPS);
  });
});

describe("the receipt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says when the document was updated, which version and where to preview it", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const [receipt] = await apply([update]);

    expect(receipt).toMatchObject({
      details: {
        preview_url: "https://cms.example/next/preview?path=%2Fnews%2Fhello",
      },
      status: "changed",
      updated_at: "2026-11-13T11:00:00.000Z",
      version_id: "91",
    });
  });

  it("names its own version when another editor saves right after", async () => {
    vi.stubGlobal("fetch", fakePayload({ overtaken: true }).handler);

    const [receipt] = await apply([update]);

    // The newest version is the other editor's; the receipt names the one
    // saved at the time the approved write reported.
    expect(receipt).toMatchObject({
      status: "changed",
      updated_at: "2026-11-13T11:00:05.000Z",
      version_id: "91",
    });
  });

  it("names no version it cannot tie to the write", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({ ignoreVersionFilter: true, overtaken: true }).handler
    );

    const [receipt] = await apply([update]);

    expect(receipt?.status).toBe("changed");
    expect(receipt).not.toHaveProperty("version_id");
  });

  it("names a new document's id", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const [receipt] = await apply([
      {
        collection: "posts",
        fields: { title: "New post" },
        kind: "create_draft",
      },
    ]);

    expect(receipt).toMatchObject({
      details: { id: "34" },
      status: "changed",
      target: "posts/34",
      updated_at: "2026-11-13T12:00:00.000Z",
      version_id: "77",
    });
  });

  it("gives the new updated time even when no value changed", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    // Payload saves a version for a write that changes nothing, which moves
    // `updatedAt`: the next write has to name the new time.
    const [receipt] = await apply([
      { ...update, fields: { title: "Old title" } },
    ]);

    expect(receipt).toMatchObject({
      changed_paths: [],
      status: "unchanged",
      updated_at: "2026-11-13T11:00:00.000Z",
    });
  });

  it("reports a document another editor has open as locked", async () => {
    vi.stubGlobal("fetch", fakePayload({ locked: true }).handler);

    const [receipt] = await apply([update]);

    expect(receipt).toMatchObject({
      changed_paths: [],
      error: { code: "locked" },
      status: "conflict",
    });
    expect(receipt?.error?.message).toContain("another editor");
  });
});

describe("describe_site", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes on collections, globals and locales", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const description = await payloadConnector.describe?.(
      env,
      caller,
      createUpstreamTelemetry()
    );

    expect(description).toMatchObject({
      globals: [{ slug: "site-settings" }],
      localization: null,
    });
    expect(description).toHaveProperty("collections.1.upload.versions", true);
  });
});
