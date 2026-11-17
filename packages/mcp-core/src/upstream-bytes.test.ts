import { FORWARDED_JWT_HEADER } from "@patronage/access";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUpstreamTelemetry,
  readBoundedBody,
  upstreamFetchBytes,
} from "./upstream";
import type { UpstreamClient } from "./upstream";

const client: UpstreamClient = {
  apiUrl: "https://cms.example",
  auth: {
    kind: "access-jwt",
    proofSecret: "proof-secret",
    token: "editor-jwt",
  },
  connector: "payload",
  label: "Payload",
};

const fileUrl = new URL("https://cms.example/api/media/file/a.png");
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const answering = (response: () => Response) => {
  const seen: Request[] = [];

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));

    return Promise.resolve(response());
  });

  return seen;
};

describe(upstreamFetchBytes, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a file as the editor and keeps its bytes", async () => {
    const seen = answering(
      () => new Response(bytes, { headers: { "Content-Type": "image/png" } })
    );

    const telemetry = createUpstreamTelemetry();
    const file = await upstreamFetchBytes(client, fileUrl, telemetry, 1024);

    expect(file).toMatchObject({ contentType: "image/png", status: 200 });
    expect(file.bytes).toStrictEqual(bytes);
    expect(seen[0]?.headers.get(FORWARDED_JWT_HEADER)).toBe("editor-jwt");
    expect(telemetry.requests).toHaveLength(1);
  });

  it("answers without bytes for a file over the limit", async () => {
    answering(() => new Response(bytes));

    const file = await upstreamFetchBytes(
      client,
      fileUrl,
      createUpstreamTelemetry(),
      4
    );

    expect(file.status).toBe(200);
    expect(file).not.toHaveProperty("bytes");
  });

  it("answers without bytes for anything but a 200", async () => {
    answering(() => new Response("gone", { status: 404 }));

    const file = await upstreamFetchBytes(
      client,
      fileUrl,
      createUpstreamTelemetry(),
      1024
    );

    expect(file.status).toBe(404);
    expect(file).not.toHaveProperty("bytes");
  });
});

describe(readBoundedBody, () => {
  it("refuses a body that declares more than the limit, unread", async () => {
    const response = new Response(bytes, {
      headers: { "Content-Length": "5000" },
    });

    await expect(
      readBoundedBody(response, { label: "The file", maxBytes: 1024 })
    ).rejects.toThrow("exceeded the size limit");
  });

  it("refuses a body that turns out to hold more than the limit", async () => {
    await expect(
      readBoundedBody(new Response(bytes), { label: "The file", maxBytes: 4 })
    ).rejects.toThrow("exceeded the size limit");
  });

  it("reads a body inside the limit whole", async () => {
    await expect(
      readBoundedBody(new Response(bytes), { label: "The file", maxBytes: 8 })
    ).resolves.toStrictEqual(bytes);
  });
});
