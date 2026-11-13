import {
  ApplyValidationError,
  createUpstreamTelemetry,
} from "@patronage/mcp-core";
import type { ApplyPreflight, JsonObject } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadSiteUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import { operationSentence, parseDraftApplyInput } from "./payload-operations";
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

const LOCALES = { defaultLocale: "en", locales: ["en", "es"] };

const collection = (slug: string, rest: JsonObject = {}): JsonObject => ({
  canCreate: true,
  canUpdate: true,
  drafts: true,
  localized: true,
  preview: true,
  richTextFields: [],
  slug,
  ...rest,
});

// What Payload keeps for each locale of a post. A Payload from before
// `getEditingInfo` listed them says a collection is localized and no more.
const POST_FIELDS: JsonObject = { localizedFields: ["title", "_status"] };

const SETTINGS: JsonObject = {
  canUpdate: true,
  drafts: false,
  localized: true,
  localizedFields: ["tagline"],
  locked: false,
  richTextFields: [],
  rowFields: [],
  slug: "site-settings",
};

const rpcSchema = z.object({ params: z.object({ name: z.string() }) });

// The fields a write to the stand-in can carry.
const writeSchema = z.object({
  _status: z.string().optional(),
  siteName: z.string().optional(),
  slug: z.string().optional(),
  tagline: z.string().optional(),
  title: z.string().optional(),
});

type Write = z.infer<typeof writeSchema>;

interface FakeOptions {
  // What `getEditingInfo` says about posts.
  posts?: JsonObject;
  // The status of the post's es locale.
  spanish?: string;
  // What `getEditingInfo` says about the site's locales.
  localization?: JsonObject | null;
}

interface Seen {
  body?: JsonObject;
  method: string;
  path: string;
  search: URLSearchParams;
}

// A Payload stand-in that keeps content in two locales: one post, published
// in en with no es title, whose `title` and `_status` are kept for each
// locale and whose `slug` is shared; and a site-settings global with a
// tagline for each locale. A request reads and writes the locale it names,
// or en.
const fakePayload = (options: FakeOptions = {}) => {
  const seen: Seen[] = [];
  const titles = new Map([["en", "Hello"]]);
  const taglines = new Map([["en", "Grow food together"]]);

  const statuses = new Map([
    ["en", "published"],
    ["es", options.spanish ?? "draft"],
  ]);

  let localization =
    options.localization === undefined ? LOCALES : options.localization;

  let siteName = "Neighborhood Growers";
  let slug = "hello";
  let stamp = READ_AT;

  const info = () => ({
    collections: [
      collection("posts", options.posts ?? POST_FIELDS),
      collection("authors", { localized: false, localizedFields: [] }),
    ],
    globals: [SETTINGS],
    localization,
  });

  const post = (locale: string): JsonObject => {
    const doc: JsonObject = { id: 3, slug, updatedAt: stamp };

    const title =
      locale === "all" ? Object.fromEntries(titles) : titles.get(locale);

    if (title !== undefined) {
      doc.title = title;
    }

    doc._status =
      locale === "all"
        ? Object.fromEntries(statuses)
        : (statuses.get(locale) ?? "draft");

    return doc;
  };

  const settings = (locale: string): JsonObject => {
    const doc: JsonObject = { siteName, updatedAt: stamp };
    const tagline = taglines.get(locale);

    if (tagline !== undefined) {
      doc.tagline = tagline;
    }

    return doc;
  };

  const writePost = (write: Write, search: URLSearchParams) => {
    const locale = search.get("locale") ?? "en";

    const everywhere =
      search.get("publishAllLocales") === "true" ||
      search.get("unpublishAllLocales") === "true";

    if (write.title !== undefined) {
      titles.set(locale, write.title);
    }

    slug = write.slug ?? slug;

    if (write._status !== undefined) {
      for (const code of everywhere ? LOCALES.locales : [locale]) {
        statuses.set(code, write._status);
      }
    }

    stamp = SAVED_AT;
  };

  const writeSettings = (write: Write, search: URLSearchParams) => {
    if (write.tagline !== undefined) {
      taglines.set(search.get("locale") ?? "en", write.tagline);
    }

    siteName = write.siteName ?? siteName;
    stamp = SAVED_AT;
  };

  const tool = (name: string) =>
    name === "getEditingInfo"
      ? { content: [], structuredContent: info() }
      : {
          content: [],
          structuredContent: {
            path: "/news/hello",
            url: "/next/preview?path=%2Fnews%2Fhello",
          },
        };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const locale = url.searchParams.get("locale") ?? "en";

    const body: JsonObject | undefined =
      request.method === "GET" ? undefined : await request.json();

    const record: Seen = {
      method: request.method,
      path: url.pathname,
      search: url.searchParams,
    };

    if (body) {
      record.body = body;
    }

    seen.push(record);

    if (url.pathname === "/api/mcp") {
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: tool(rpcSchema.parse(body).params.name),
      });
    }

    if (url.pathname.endsWith("/versions")) {
      return Response.json({
        docs: [{ id: 18, version: { updatedAt: stamp } }],
      });
    }

    if (url.pathname.startsWith("/api/globals/")) {
      if (body) {
        writeSettings(writeSchema.parse(body), url.searchParams);
      }

      return Response.json(
        body ? { message: "Saved", result: settings(locale) } : settings(locale)
      );
    }

    if (body) {
      writePost(writeSchema.parse(body), url.searchParams);

      return Response.json({ doc: post(locale) });
    }

    return Response.json(post(locale));
  };

  return {
    // The site drops its es locale between the preview and the write.
    dropSpanish: () => {
      localization = { defaultLocale: "en", locales: ["en"] };
    },
    handler,
    rest: () => seen.filter((request) => request.path !== "/api/mcp"),
    seen,
    statuses: () => Object.fromEntries(statuses),
    titles: () => Object.fromEntries(titles),
    // The writes Payload's REST API was sent.
    writes: () =>
      seen.filter((request) => request.body && request.path !== "/api/mcp"),
  };
};

const POST = { collection: "posts", expected_updated_at: READ_AT, id: 3 };

const update = (rest: JsonObject = {}): PayloadOperation =>
  parseDraftApplyInput({
    intent: "Translate the post",
    operations: [{ ...POST, kind: "update_draft", ...rest }],
  }).operations[0];

const preflight = (operations: PayloadOperation[]): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Translate the post",
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

// The locale a request names, and what it falls back to.
const localeOf = (request: Seen): string =>
  `${request.search.get("locale")}/${request.search.get("fallback-locale")}`;

const TRANSLATION = { fields: { slug: "hola", title: "Hola" }, locale: "es" };

describe("a write that names a locale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("previews that locale's values and marks who each field is for", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const preview = await preflight([update(TRANSLATION)]);

    expect(preview.operations[0]).toMatchObject({
      fields: [
        {
          after: "hola",
          before: "hello",
          label: "slug · every locale",
          path: "slug",
        },
        { after: "Hola", before: "", label: "title · es only", path: "title" },
      ],
      sentence: "Save slug and title as a draft of posts 3, in the es locale",
    });
    expect(preview.operations[0]?.warning).toBeUndefined();
  });

  it("sends every REST request in that locale, and none to Payload's MCP", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);
    await apply([update(TRANSLATION)]);

    expect(fake.rest().length).toBeGreaterThan(3);
    expect(new Set(fake.rest().map(localeOf))).toStrictEqual(
      new Set(["es/none"])
    );
    expect(
      fake.seen
        .filter((request) => request.path === "/api/mcp")
        .some((request) => request.search.has("locale"))
    ).toBeFalsy();
  });

  it("writes that locale alone and names it in the receipt", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([update(TRANSLATION)]);

    expect(receipt).toMatchObject({
      changed_paths: ["slug", "title"],
      details: { locale: "es" },
      status: "changed",
    });
    expect(fake.titles()).toStrictEqual({ en: "Hello", es: "Hola" });
    expect(fake.statuses()).toStrictEqual({ en: "published", es: "draft" });
  });

  it("names the locale in the sentence the inline card shows", () => {
    expect(operationSentence(update(TRANSLATION))).toBe(
      "Save slug and title as a draft of posts 3, in the es locale"
    );
    expect(operationSentence(update({ fields: { title: "Hi" } }))).toBe(
      "Save title as a draft of posts 3"
    );
  });

  it.each<[string, FakeOptions, JsonObject]>([
    ["not_localized", { localization: null }, {}],
    ["not_localized", {}, { collection: "authors" }],
    ["unknown_locale", {}, { locale: "fr" }],
    ["localized_fields_unknown", { posts: {} }, {}],
  ])("refuses with %s", async (code, options, operation) => {
    const fake = fakePayload(options);

    vi.stubGlobal("fetch", fake.handler);

    await expect(
      preflight([update({ ...TRANSLATION, ...operation })])
    ).rejects.toMatchObject({ code });
    expect(fake.writes()).toStrictEqual([]);
  });

  it("refuses at the write when the site no longer has the locale", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [receipt] = await apply([update(TRANSLATION)], fake.dropSpanish);

    expect(receipt).toMatchObject({
      changed_paths: [],
      error: { code: "unknown_locale" },
      status: "failed",
    });
    expect(fake.writes()).toStrictEqual([]);
  });
});

describe("a write that names no locale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes to the default locale as before, and the preview says so", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const operation = update({ fields: { slug: "hi", title: "Hi" } });
    const preview = await preflight([operation]);

    await apply([operation]);

    expect(preview.operations[0]).toMatchObject({
      fields: [
        { label: "slug · every locale", path: "slug" },
        { before: "Hello", label: "title · en only", path: "title" },
      ],
      sentence: "Save slug and title as a draft of posts 3, in the en locale",
    });
    expect(
      fake.rest().filter((request) => request.search.has("locale"))
    ).toStrictEqual([]);
    expect(fake.titles()).toStrictEqual({ en: "Hi" });
  });

  it("is not marked on a site without locales", async () => {
    vi.stubGlobal("fetch", fakePayload({ localization: null }).handler);

    const preview = await preflight([update({ fields: { title: "Hi" } })]);

    expect(preview.operations[0]?.sentence).toBe(
      "Save title as a draft of posts 3"
    );
    expect(preview.operations[0]?.fields[0]?.label).toBeUndefined();
  });

  it("is not marked on a collection with no localized field", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({ posts: { localized: false, localizedFields: [] } }).handler
    );

    const preview = await preflight([update({ fields: { title: "Hi" } })]);

    expect(preview.operations[0]?.fields[0]?.label).toBeUndefined();
  });
});

const ONE_LOCALE =
  "This publishes the es locale only. Fields marked “every locale” go live for all locales, along with shared changes saved in earlier drafts.";

const ALL_LOCALES =
  "This publishes every locale, each with what its newest draft holds. Only the es locale is shown here.";

describe("publishing where each locale has a status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes the named locale alone and warns what goes live for all", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const operation = update({ ...TRANSLATION, publish: true });
    const preview = await preflight([operation]);

    await apply([operation]);

    expect(preview.operations[0]?.warning).toBe(ONE_LOCALE);
    expect(preview.operations[0]?.fields.at(-1)).toMatchObject({
      after: "published",
      before: "draft",
      label: "_status · es only",
    });
    expect(fake.writes()[0]?.search.has("publishAllLocales")).toBeFalsy();
    expect(fake.statuses()).toStrictEqual({ en: "published", es: "published" });
  });

  it("publishes every locale when asked, and says so", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const operation = update({
      ...TRANSLATION,
      publish: true,
      publish_all_locales: true,
    });

    const preview = await preflight([operation]);

    await apply([operation]);

    expect(preview.operations[0]?.warning).toBe(ALL_LOCALES);
    expect(preview.operations[0]?.fields.at(-1)).toMatchObject({
      label: "_status · every locale",
    });
    expect(fake.writes()[0]?.search.get("publishAllLocales")).toBe("true");
  });

  it("does not warn where the status is shared by every locale", async () => {
    vi.stubGlobal(
      "fetch",
      fakePayload({ posts: { localizedFields: ["title"] } }).handler
    );

    const preview = await preflight([
      update({ ...TRANSLATION, publish: true }),
    ]);

    expect(preview.operations[0]?.warning).toBeUndefined();
    expect(preview.operations[0]?.fields.at(-1)).toMatchObject({
      label: "_status · every locale",
    });
  });

  const retitle = { ...POST, fields: { title: "Hi" }, kind: "update_draft" };

  it.each<[string, JsonObject]>([
    [
      "publish_all_locales without publish",
      { ...retitle, publish_all_locales: true },
    ],
    ["the locale all", { ...retitle, locale: "all" }],
    ["the locale none", { ...retitle, locale: "none" }],
    ["a locale that is not a code", { ...retitle, locale: "es&draft=false" }],
    [
      "a locale on a restore",
      { ...POST, kind: "restore_version", locale: "es", version_id: 18 },
    ],
    ["a locale on the trash", { ...POST, kind: "trash", locale: "es" }],
    [
      "publish_all_locales on an unpublish",
      { ...POST, kind: "unpublish", publish_all_locales: true },
    ],
  ])("refuses %s", (_what, operation) => {
    expect(() =>
      parseDraftApplyInput({ intent: "Change it", operations: [operation] })
    ).toThrow(ApplyValidationError);
  });
});

const unpublish = (rest: JsonObject = {}): PayloadOperation =>
  parseDraftApplyInput({
    intent: "Take the post down",
    operations: [{ ...POST, kind: "unpublish", ...rest }],
  }).operations[0];

describe("unpublishing where each locale has a status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes one locale down and leaves the others", async () => {
    const fake = fakePayload({ spanish: "published" });

    vi.stubGlobal("fetch", fake.handler);

    const operation = unpublish({ locale: "es" });
    const preview = await preflight([operation]);
    const [receipt] = await apply([operation]);

    expect(preview.operations[0]).toMatchObject({
      fields: [{ before: "published", label: "_status · es only" }],
      sentence: "Unpublish posts 3, in the es locale",
      warning:
        "Only the es locale is unpublished; the others stay as they are. The es version of the public page at /news/hello goes away as soon as you approve. Links to it will 404 unless a redirect covers them.",
    });
    expect(receipt).toMatchObject({ status: "changed" });
    expect(fake.writes()[0]?.search.has("unpublishAllLocales")).toBeFalsy();
    expect(fake.statuses()).toStrictEqual({ en: "published", es: "draft" });
  });

  it("names the locales a whole-document unpublish takes down", async () => {
    const fake = fakePayload({ spanish: "published" });

    vi.stubGlobal("fetch", fake.handler);

    const preview = await preflight([unpublish()]);

    await apply([unpublish()]);

    expect(preview.operations[0]).toMatchObject({
      fields: [
        { before: "published in en, es", label: "_status · every locale" },
      ],
      sentence: "Unpublish posts 3 in every locale",
    });
    expect(fake.writes()[0]?.search.get("unpublishAllLocales")).toBe("true");
    expect(fake.statuses()).toStrictEqual({ en: "draft", es: "draft" });
  });

  it("refuses one locale where the status is shared by all", async () => {
    const fake = fakePayload({
      posts: { localizedFields: ["title"] },
      spanish: "published",
    });

    vi.stubGlobal("fetch", fake.handler);

    await expect(
      preflight([unpublish({ locale: "es" })])
    ).rejects.toMatchObject({ code: "status_not_per_locale" });
    expect(fake.writes()).toStrictEqual([]);
  });

  it("refuses a locale that is not published, by name", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight([unpublish({ locale: "es" })])
    ).rejects.toMatchObject({
      code: "already_draft",
      message: expect.stringContaining("es locale"),
    });
  });
});

describe("a global in a locale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the locale's value and marks the shared field", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const [operation] = parseDraftApplyInput({
      intent: "Translate the tagline",
      operations: [
        {
          expected_updated_at: READ_AT,
          fields: { siteName: "Growers", tagline: "Cultivamos juntos" },
          global: "site-settings",
          kind: "update_global",
          locale: "es",
          publish: true,
        },
      ],
    }).operations;

    const preview = await preflight([operation]);
    const [receipt] = await apply([operation]);

    expect(preview.operations[0]).toMatchObject({
      fields: [
        { label: "siteName · every locale" },
        { before: "", label: "tagline · es only" },
      ],
      sentence:
        "Save siteName and tagline to the site-settings global and publish it, in the es locale",
    });
    expect(receipt).toMatchObject({
      details: { locale: "es" },
      status: "changed",
    });
    expect(fake.writes()[0]?.search.get("locale")).toBe("es");
  });
});
