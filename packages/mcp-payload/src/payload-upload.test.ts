import {
  ApplyValidationError,
  createUpstreamTelemetry,
  sha256Hex,
} from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  JsonObject,
  RuntimeStore,
  StagedBlob,
} from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadSiteUrl } from "./payload";
import {
  applyDraftOperations,
  preflightDraftOperations,
} from "./payload-apply";
import type { UploadEditing } from "./payload-editing";
import { parseDraftApplyInput } from "./payload-operations";
import type { PayloadOperation } from "./payload-operations";
import {
  MAX_BASE64_UPLOAD_BYTES,
  stageUpload,
  urlAllowed,
} from "./payload-upload";

const env: PayloadEnv = {
  PAYLOAD_ACCESS_PROOF_SECRET: "proof-secret",
  PAYLOAD_ADMIN_URL: "https://cms.example",
  PAYLOAD_API_URL: "https://payload.example",
};

const caller = { subjectOpaque: "editor0000000000", token: "editor-jwt" };
const client = () => createPayloadClient(env, caller);

const adminUrl = (collection: string, id: number | string) =>
  `https://cms.example/admin/collections/${collection}/${id}`;

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const png = (length = 64, fill = 7): Uint8Array => {
  const bytes = new Uint8Array(length).fill(fill);

  bytes.set(PNG_HEAD);

  return bytes;
};

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes));

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);

type AllowList = NonNullable<UploadEditing["urlAllowList"]>;

const ALLOW_LIST: AllowList = [
  { hostname: "images.example", pathname: "/library/**", protocol: "https" },
];

interface InfoOptions {
  canCreate?: boolean;
  maxFileSize?: number | null;
  urlAllowList?: AllowList | null;
  versions?: boolean;
}

const editingInfo = (options: InfoOptions = {}) => ({
  collections: [
    {
      canCreate: options.canCreate ?? true,
      canUpdate: true,
      drafts: false,
      relationFields: [],
      richTextFields: [],
      slug: "media",
      titleField: "filename",
      upload: {
        maxFileSize: options.maxFileSize ?? null,
        mimeTypes: ["image/*"],
        urlAllowList:
          options.urlAllowList === undefined
            ? ALLOW_LIST
            : options.urlAllowList,
        versions: options.versions ?? true,
      },
    },
    {
      canCreate: true,
      canUpdate: true,
      drafts: true,
      richTextFields: [],
      slug: "posts",
    },
  ],
});

// The store of one run's staged files, as the gateway keeps them.
const fakeStore = () => {
  const files = new Map<string, { blob: StagedBlob; bytes: Uint8Array }>();

  const store: RuntimeStore = {
    readBlob: (_executionId, sha256) => Promise.resolve(files.get(sha256)),
    readBlobMeta: (_executionId, sha256) =>
      Promise.resolve(files.get(sha256)?.blob),
    readPreflight: () => Promise.resolve(undefined),
    readRequester: () => Promise.resolve("requester0000000"),
    stageBlob: async (executionId, bytes, facts) => {
      const blob: StagedBlob = {
        ...facts,
        bytes: bytes.byteLength,
        chunks: 1,
        executionId,
        sha256: await sha256Hex(bytes),
        stagedAt: 1,
      };

      files.set(blob.sha256, { blob, bytes });

      return blob;
    },
    writePreflight: () => Promise.resolve(),
  };

  return { files, store };
};

interface FakeOptions extends InfoOptions {
  // Payload stores the file under another name, as it does for one taken.
  renamed?: boolean;
}

const OLD_FILE = png(48, 3);

// A Payload stand-in with one media file, which takes uploads on its REST
// routes the way Payload does: a `file` part and the fields as `_payload`.
const fakePayload = (options: FakeOptions = {}) => {
  const requests: string[] = [];
  const uploads: { fields: JsonObject; file: File; method: string }[] = [];

  let media: JsonObject = {
    alt: "Raised beds in spring",
    filename: "raised-beds.png",
    filesize: OLD_FILE.byteLength,
    height: 600,
    id: 7,
    mimeType: "image/png",
    updatedAt: "2026-11-13T10:00:00.000Z",
    url: "/api/media/file/raised-beds.png",
    width: 800,
  };

  const versions: { id: number; updatedAt: string }[] = [];

  const upload = async (request: Request, id: number, updatedAt: string) => {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return Response.json(
        { errors: [{ message: "No files were uploaded." }] },
        { status: 400 }
      );
    }

    const fields: JsonObject = JSON.parse(String(form.get("_payload")));
    const filename = options.renamed ? `1-${file.name}` : file.name;

    uploads.push({ fields, file, method: request.method });

    const kept: JsonObject = id === 7 ? media : { id };

    media = {
      ...kept,
      ...fields,
      filename,
      filesize: file.size,
      id,
      mimeType: file.type,
      updatedAt,
      url: `/api/media/file/${filename}`,
    };

    versions.push({ id: id + 100, updatedAt });

    return Response.json({ doc: media }, { status: id === 7 ? 200 : 201 });
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    requests.push(`${request.method} ${url.pathname}`);

    if (url.pathname === "/api/mcp") {
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: { content: [], structuredContent: editingInfo(options) },
      });
    }

    if (url.pathname.endsWith("/versions")) {
      const stamp = url.searchParams.get("where[version.updatedAt][equals]");

      return Response.json({
        docs: versions.flatMap(({ id, updatedAt }) =>
          updatedAt === stamp ? [{ id, version: { updatedAt } }] : []
        ),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/media") {
      return await upload(request, 8, "2026-11-13T12:00:00.000Z");
    }

    if (request.method === "PATCH" && url.pathname === "/api/media/7") {
      return await upload(request, 7, "2026-11-13T11:00:00.000Z");
    }

    if (url.pathname === "/api/media/file/raised-beds.png") {
      return new Response(OLD_FILE, {
        headers: { "Content-Type": "image/png" },
      });
    }

    return url.pathname === `/api/media/${media.id}`
      ? Response.json(media)
      : Response.json({ errors: [{ message: "Not Found" }] }, { status: 404 });
  };

  return {
    handler,
    requests,
    // Another editor saves the document between the preview and the write.
    touch: () => {
      media = { ...media, updatedAt: "2026-11-13T10:30:00.000Z" };
    },
    uploads,
  };
};

type StageSource =
  | { base64: string; filename: string; mimeType: string }
  | { url: string };

const stage = (
  store: RuntimeStore,
  source: StageSource,
  fetcher: typeof fetch = () => Promise.reject(new Error("no fetch expected"))
) =>
  stageUpload(
    {
      client: client(),
      executionId: "exec_1",
      fetcher,
      images: undefined,
      store,
      telemetry: createUpstreamTelemetry(),
    },
    { collection: "media", source }
  );

const fromBase64 = (bytes: Uint8Array, filename = "harvest.png") => ({
  base64: base64(bytes),
  filename,
  mimeType: "image/png",
});

describe("payload.stageUpload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a base64 file and names it by its hash", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { files, store } = fakeStore();
    const bytes = png();
    const staged = await stage(store, fromBase64(bytes));

    expect(staged).toStrictEqual({
      bytes: 64,
      filename: "harvest.png",
      mimeType: "image/png",
      source: "uploaded file",
      upload_ref: `sha256:${await sha256Hex(bytes)}`,
    });

    expect(files.size).toBe(1);
  });

  it("fetches a URL on the collection's allow-list", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();
    const fetched: string[] = [];

    const staged = await stage(
      store,
      { url: "https://images.example/library/2026/Harvest%20day.png?x=1" },
      (input) => {
        fetched.push(String(input));

        return Promise.resolve(new Response(png()));
      }
    );

    expect(fetched).toHaveLength(1);
    expect(staged).toMatchObject({
      filename: "Harvest day.png",
      mimeType: "image/png",
      source: "images.example",
    });
  });

  it("refuses a URL the collection does not allow, without fetching it", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { files, store } = fakeStore();

    await expect(
      stage(store, { url: "https://elsewhere.example/library/a.png" })
    ).rejects.toThrow("elsewhere.example is not a place");

    await expect(
      stage(store, { url: "https://images.example/private/a.png" })
    ).rejects.toThrow("not a place");

    expect(files.size).toBe(0);
  });

  it("refuses a redirect that leaves the allow-list", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();
    const fetched: string[] = [];

    await expect(
      stage(store, { url: "https://images.example/library/a.png" }, (input) => {
        fetched.push(String(input));

        return Promise.resolve(
          new Response(null, {
            headers: { Location: "https://169.254.169.254/latest/meta-data" },
            status: 302,
          })
        );
      })
    ).rejects.toThrow("169.254.169.254 is not a place");

    expect(fetched).toStrictEqual(["https://images.example/library/a.png"]);
  });

  it("follows a redirect that stays on the allow-list", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();

    const staged = await stage(
      store,
      { url: "https://images.example/library/a.png" },
      (input) =>
        Promise.resolve(
          String(input).endsWith("/a.png")
            ? new Response(null, {
                headers: { Location: "/library/moved/b.png" },
                status: 301,
              })
            : new Response(png())
        )
    );

    // Named after the address that was asked for.
    expect(staged).toMatchObject({ bytes: 64, filename: "a.png" });
  });

  it("refuses a URL when the collection takes none", async () => {
    vi.stubGlobal("fetch", fakePayload({ urlAllowList: null }).handler);

    await expect(
      stage(fakeStore().store, { url: "https://images.example/library/a.png" })
    ).rejects.toThrow("takes no files by URL");
  });

  it("refuses an SVG, whatever it is declared as", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { files, store } = fakeStore();

    await expect(
      stage(store, {
        base64: base64(SVG),
        filename: "logo.png",
        mimeType: "image/png",
      })
    ).rejects.toThrow("SVG files are not accepted");

    expect(files.size).toBe(0);
  });

  it("refuses a file that is not what it was declared as", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();

    await expect(
      stage(store, {
        base64: base64(png()),
        filename: "harvest.jpg",
        mimeType: "image/jpeg",
      })
    ).rejects.toThrow("The file is image/png, not image/jpeg as declared");

    await expect(
      stage(store, fromBase64(png(), "harvest.jpg"))
    ).rejects.toThrow("does not have the extension of a image/png file");

    await expect(
      stage(store, fromBase64(new Uint8Array(64).fill(1)))
    ).rejects.toThrow("not a type this gateway can upload");
  });

  it("refuses a file over the collection's size limit", async () => {
    vi.stubGlobal("fetch", fakePayload({ maxFileSize: 1024 }).handler);

    const { store } = fakeStore();

    await expect(stage(store, fromBase64(png(2048)))).rejects.toThrow(
      "this collection takes at most"
    );

    await expect(
      stage(store, { url: "https://images.example/library/a.png" }, () =>
        Promise.resolve(new Response(png(2048)))
      )
    ).rejects.toThrow("larger than");
  });

  it("refuses base64 over 1 MB, and anything that is not base64", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();

    await expect(
      stage(store, {
        base64: "A".repeat(Math.ceil(MAX_BASE64_UPLOAD_BYTES / 3) * 4 + 4),
        filename: "big.png",
        mimeType: "image/png",
      })
    ).rejects.toThrow("at most 1 MB");

    await expect(
      stage(store, {
        base64: `data:image/png;base64,${base64(png())}`,
        filename: "harvest.png",
        mimeType: "image/png",
      })
    ).rejects.toThrow("not plain base64");
  });

  it("refuses a collection that holds no files", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      stageUpload(
        {
          client: client(),
          executionId: "exec_1",
          images: undefined,
          store: fakeStore().store,
          telemetry: createUpstreamTelemetry(),
        },
        { collection: "posts", source: fromBase64(png()) }
      )
    ).rejects.toThrow("posts is not an upload collection");
  });
});

const allowed = (address: string, list: AllowList = ALLOW_LIST): boolean =>
  urlAllowed(new URL(address), list);

describe(urlAllowed, () => {
  it("matches the host and the path the way Payload does", () => {
    expect(allowed("https://images.example/library/a.png")).toBeTruthy();
    expect(
      allowed("https://images.example/library/2026/11/a.png")
    ).toBeTruthy();
    expect(allowed("https://images.example/other/a.png")).toBeFalsy();
    expect(allowed("https://cdn.images.example/library/a.png")).toBeFalsy();

    expect(
      allowed("https://images.example/a/b.png", [
        { hostname: "images.example", pathname: "/*/b.png" },
      ])
    ).toBeTruthy();
  });

  it("takes HTTPS only, with no credentials and no unlisted port", () => {
    const anyPath: AllowList = [{ hostname: "images.example" }];

    expect(allowed("http://images.example/a.png", anyPath)).toBeFalsy();
    expect(
      allowed("https://user:pw@images.example/a.png", anyPath)
    ).toBeFalsy();
    expect(allowed("https://images.example:8443/a.png", anyPath)).toBeFalsy();

    expect(
      allowed("https://images.example:8443/a.png", [
        { hostname: "images.example", port: "8443" },
      ])
    ).toBeTruthy();
  });
});

const staged = async (store: RuntimeStore, bytes = png()): Promise<string> => {
  await stage(store, fromBase64(bytes));

  return `sha256:${await sha256Hex(bytes)}`;
};

const preflight = (
  store: RuntimeStore,
  operations: PayloadOperation[]
): Promise<ApplyPreflight> =>
  preflightDraftOperations(
    client(),
    "Add the harvest photo",
    operations,
    adminUrl,
    createUpstreamTelemetry(),
    { files: { executionId: "exec_1", images: undefined, store } }
  );

const apply = async (
  store: RuntimeStore,
  operations: PayloadOperation[],
  between: () => void = () => {
    // Nothing happens between the preview and the write.
  }
) => {
  const approved = await preflight(store, operations);

  between();

  const receipt = await applyDraftOperations({
    approverOpaque: "approver00000000",
    client: client(),
    executionId: "exec_1",
    files: { images: undefined, store },
    operations,
    preflight: approved,
    requesterOpaque: "requester0000000",
    siteUrl: (link) => payloadSiteUrl(env, link),
    telemetry: createUpstreamTelemetry(),
  });

  return receipt.operations;
};

describe("upload_media", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the staged file and its fields for approval", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();
    const bytes = png();
    const ref = await staged(store, bytes);

    const preview = await preflight(store, [
      {
        collection: "media",
        fields: { alt: "Harvest day" },
        kind: "upload_media",
        upload_ref: ref,
      },
    ]);

    const [operation] = preview.operations;

    expect(operation).toMatchObject({
      editUrl: "",
      modifiedGmt: "",
      sentence: "Upload harvest.png to media",
      target: "media/new",
    });

    expect(operation).not.toHaveProperty("warning");

    expect(operation?.fields).toStrictEqual([
      {
        after: "harvest.png, from uploaded file",
        afterImage: {
          bytes: 64,
          height: 0,
          mimeType: "image/png",
          sha256: await sha256Hex(bytes),
          src: "",
          width: 0,
        },
        before: "",
        changed: true,
        path: "file",
      },
      { after: "Harvest day", before: "", changed: true, path: "alt" },
    ]);
  });

  it("refuses a file this run never staged", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    await expect(
      preflight(fakeStore().store, [
        {
          collection: "media",
          kind: "upload_media",
          upload_ref: `sha256:${"0".repeat(64)}`,
        },
      ])
    ).rejects.toMatchObject({ code: "upload_not_staged" });
  });

  it("refuses an editor who may not upload", async () => {
    vi.stubGlobal("fetch", fakePayload({ canCreate: false }).handler);

    const { store } = fakeStore();
    const ref = await staged(store);

    await expect(
      preflight(store, [
        { collection: "media", kind: "upload_media", upload_ref: ref },
      ])
    ).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("sends the file through Payload's own upload route", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const { store } = fakeStore();
    const bytes = png();
    const ref = await staged(store, bytes);

    const [receipt] = await apply(store, [
      {
        collection: "media",
        fields: { alt: "Harvest day" },
        filename: "harvest-day.png",
        kind: "upload_media",
        upload_ref: ref,
      },
    ]);

    const [upload] = fake.uploads;

    const sent = await upload?.file.arrayBuffer();

    expect({
      fields: upload?.fields,
      method: upload?.method,
      name: upload?.file.name,
      type: upload?.file.type,
    }).toStrictEqual({
      fields: { alt: "Harvest day" },
      method: "POST",
      name: "harvest-day.png",
      type: "image/png",
    });

    expect(new Uint8Array(sent ?? [])).toStrictEqual(bytes);

    expect(receipt).toStrictEqual({
      changed_paths: ["file", "alt"],
      details: {
        filename: "harvest-day.png",
        id: "8",
        url: "https://cms.example/api/media/file/harvest-day.png",
      },
      kind: "upload_media",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "media/8",
      updated_at: "2026-11-13T12:00:00.000Z",
      version_id: "108",
    });
  });

  it("reports the name Payload stored the file under", async () => {
    vi.stubGlobal("fetch", fakePayload({ renamed: true }).handler);

    const { store } = fakeStore();
    const ref = await staged(store);

    const [receipt] = await apply(store, [
      { collection: "media", kind: "upload_media", upload_ref: ref },
    ]);

    expect(receipt).toMatchObject({
      details: { filename: "1-harvest.png" },
      normalized_paths: ["file"],
      status: "changed",
    });
  });

  it("reports an upload with no store as never staged", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();
    const ref = await staged(store);

    const operations: PayloadOperation[] = [
      { collection: "media", kind: "upload_media", upload_ref: ref },
    ];

    const receipt = await applyDraftOperations({
      approverOpaque: "approver00000000",
      client: client(),
      executionId: "exec_1",
      operations,
      preflight: await preflight(store, operations),
      requesterOpaque: "requester0000000",
      telemetry: createUpstreamTelemetry(),
    });

    expect(receipt.operations[0]).toMatchObject({
      error: { code: "upload_not_staged" },
      status: "failed",
    });
  });
});

const replace = (
  ref: string
): Extract<PayloadOperation, { kind: "replace_media_file" }> => ({
  collection: "media",
  expected_updated_at: "2026-11-13T10:00:00.000Z",
  id: 7,
  kind: "replace_media_file",
  upload_ref: ref,
});

describe("replace_media_file", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the file there now beside the new one, with a warning", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();
    const ref = await staged(store);
    const preview = await preflight(store, [replace(ref)]);
    const [operation] = preview.operations;
    const [file] = operation?.fields ?? [];

    expect(operation).toMatchObject({
      editUrl: "https://cms.example/admin/collections/media/7",
      modifiedGmt: "2026-11-13T10:00:00.000Z",
      sentence: "Replace the file of media 7 with harvest.png",
      target: "media/7",
    });

    expect(operation?.warning).toContain("kept as an earlier version");

    expect(file).toMatchObject({
      after: "harvest.png, from uploaded file",
      before: "raised-beds.png",
      beforeImage: {
        bytes: OLD_FILE.byteLength,
        mimeType: "image/png",
        sha256: await sha256Hex(OLD_FILE),
      },
      changed: true,
    });
  });

  it("says the old file is deleted where no versions are kept", async () => {
    vi.stubGlobal("fetch", fakePayload({ versions: false }).handler);

    const { store } = fakeStore();
    const ref = await staged(store);
    const preview = await preflight(store, [replace(ref)]);

    expect(preview.operations[0]?.warning).toContain("is deleted");
  });

  it("refuses a document that changed since it was read", async () => {
    vi.stubGlobal("fetch", fakePayload().handler);

    const { store } = fakeStore();
    const ref = await staged(store);

    await expect(
      preflight(store, [
        { ...replace(ref), expected_updated_at: "2026-11-01T00:00:00.000Z" },
      ])
    ).rejects.toMatchObject({ code: "stale_expected_updated_at" });
  });

  it("replaces the file and names the version it made", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const { store } = fakeStore();
    const ref = await staged(store);
    const [receipt] = await apply(store, [replace(ref)]);

    expect(fake.uploads[0]?.method).toBe("PATCH");

    expect(receipt).toStrictEqual({
      changed_paths: ["file"],
      details: {
        filename: "harvest.png",
        url: "https://cms.example/api/media/file/harvest.png",
      },
      kind: "replace_media_file",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "media/7",
      updated_at: "2026-11-13T11:00:00.000Z",
      version_id: "107",
    });
  });

  it("writes nothing when the document changed after the preview", async () => {
    const fake = fakePayload();

    vi.stubGlobal("fetch", fake.handler);

    const { store } = fakeStore();
    const ref = await staged(store);
    const [receipt] = await apply(store, [replace(ref)], fake.touch);

    expect(fake.uploads).toHaveLength(0);

    expect(receipt).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
  });
});

const SOME_REF = `sha256:${"a".repeat(64)}`;

const parse = (operation: JsonObject) =>
  parseDraftApplyInput({ intent: "Add a photo", operations: [operation] });

describe("upload operations in payload.apply", () => {
  it("takes an upload and a replacement", () => {
    expect(
      parse({ collection: "media", kind: "upload_media", upload_ref: SOME_REF })
        .operations
    ).toHaveLength(1);

    expect(
      parse({
        collection: "media",
        expected_updated_at: "2026-11-13T10:00:00.000Z",
        id: 7,
        kind: "replace_media_file",
        upload_ref: SOME_REF,
      }).operations
    ).toHaveLength(1);
  });

  it("refuses a replacement that does not say what it read", () => {
    expect(() =>
      parse({
        collection: "media",
        id: 7,
        kind: "replace_media_file",
        upload_ref: SOME_REF,
      })
    ).toThrow(ApplyValidationError);
  });

  it("refuses bytes, a path or a URL where a staged file is named", () => {
    for (const bad of ["sha256:abc", "https://images.example/a.png", "a.png"]) {
      expect(() =>
        parse({ collection: "media", kind: "upload_media", upload_ref: bad })
      ).toThrow(ApplyValidationError);
    }

    expect(() =>
      parse({
        collection: "media",
        filename: "../etc/passwd.png",
        kind: "upload_media",
        upload_ref: SOME_REF,
      })
    ).toThrow(ApplyValidationError);
  });
});
