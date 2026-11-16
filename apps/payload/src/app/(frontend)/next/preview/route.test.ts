import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  enable: vi.fn<() => void>(),
  getFrontendPayload:
    vi.fn<() => Promise<{ user: { email: string; id: number } | null }>>(),
  redirect: vi.fn<(url: string) => never>((url) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; stands in for Payload, so the test needs no database.
vi.mock("@/lib/payload", () => ({
  getFrontendPayload: mocks.getFrontendPayload,
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; request headers and cookies exist only inside a Next request.
vi.mock("next/headers", () => ({
  draftMode: () => Promise.resolve({ enable: mocks.enable }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; redirect() throws Next's control-flow error outside a request.
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const ORIGIN = "https://site.example.org";

const get = (path: string) => {
  const url = new URL("/next/preview", ORIGIN);

  url.searchParams.set("path", path);

  // SAFETY: the handler reads only nextUrl from the request.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial NextRequest.
  return { nextUrl: url } as unknown as NextRequest;
};

const editor = { email: "editor@example.org", id: 1 };

describe("GET /next/preview", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("answers 403 without a logged-in user", async () => {
    mocks.getFrontendPayload.mockResolvedValue({ user: null });

    const response = await GET(get("/about"));

    expect(response.status).toBe(403);
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it.each([
    "https://elsewhere.example.com/",
    "//elsewhere.example.com",
    "/\\elsewhere.example.com",
    "about",
    "",
  ])("answers 400 to the off-site path %j", async (path) => {
    mocks.getFrontendPayload.mockResolvedValue({ user: editor });

    const response = await GET(get(path));

    expect(response.status).toBe(400);
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("turns on draft mode and redirects an editor to the path on this site", async () => {
    mocks.getFrontendPayload.mockResolvedValue({ user: editor });

    await expect(GET(get("/news/launch?draft=1#top"))).rejects.toThrow(
      "NEXT_REDIRECT /news/launch?draft=1#top"
    );
    expect(mocks.enable).toHaveBeenCalledOnce();
  });
});
