import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "./route";

const cache = vi.hoisted(() => ({
  revalidatePath: vi.fn<(path: string) => void>(),
  revalidateTag: vi.fn<(tag: string, profile?: { expire: number }) => void>(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; the data cache exists only inside a Next request.
vi.mock("next/cache", () => cache);

const SECRET = "revalidate-secret";

interface RevalidateBody {
  paths?: (string | number)[];
  tags?: string[] | string;
}

const putText = (body: string, secret: string | null = SECRET) =>
  new Request("https://site.example.org/api/revalidate", {
    body,
    headers: secret === null ? {} : { "x-headless-secret-key": secret },
    method: "PUT",
  });

const put = (body: RevalidateBody, secret: string | null = SECRET) =>
  putText(JSON.stringify(body), secret);

const expiredTags = () => cache.revalidateTag.mock.calls.map(([tag]) => tag);

describe("PUT /api/revalidate", () => {
  beforeEach(() => {
    vi.stubEnv("WORDPRESS_URL", "https://cms.example.org");
    vi.stubEnv("HEADLESS_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([
    ["a wrong secret", "not-the-secret"],
    ["no secret", null],
  ])("answers 401 to %s without reading the body", async (_, secret) => {
    const request = put({ paths: ["/about"] }, secret);
    const response = await PUT(request);

    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBeFalsy();
    expect(cache.revalidateTag).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers 401 when no secret is configured, even to an empty header", async () => {
    vi.stubEnv("HEADLESS_SECRET", "");

    const response = await PUT(put({ paths: [] }, ""));

    expect(response.status).toBe(401);
  });

  it.each([
    ["malformed JSON", "{paths:"],
    ["paths that are not strings", JSON.stringify({ paths: [1] })],
    ["tags that are not a list", JSON.stringify({ tags: "post:1" })],
  ])("answers 400 to %s", async (_, body) => {
    const response = await PUT(putText(body));

    expect(response.status).toBe(400);
    expect(cache.revalidateTag).not.toHaveBeenCalled();
  });

  it("expires each tag and each path, turning paths into path tags", async () => {
    const response = await PUT(
      put({ paths: ["/about/", "/news/caf%c3%a9"], tags: ["cG9zdDox"] })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      paths: ["/about/", "/news/caf%c3%a9"],
      revalidated: true,
      tags: ["cG9zdDox"],
    });
    expect(expiredTags()).toStrictEqual([
      "cG9zdDox",
      "path:/about",
      "path:/news/caf%C3%A9",
    ]);
    expect(cache.revalidateTag).toHaveBeenCalledWith("cG9zdDox", {
      expire: 0,
    });
    expect(cache.revalidatePath.mock.calls.map(([path]) => path)).toStrictEqual(
      ["/about/", "/news/caf%c3%a9"]
    );
  });

  it("expires a tag named twice only once", async () => {
    await PUT(put({ paths: ["/about"], tags: ["path:/about"] }));

    expect(expiredTags()).toStrictEqual(["path:/about"]);
  });

  it("reports nothing revalidated for an empty request", async () => {
    const response = await PUT(put({}));
    const answer = await response.json();

    expect(answer).toMatchObject({ revalidated: false });
  });
});
