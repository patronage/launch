import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const next = vi.hoisted(() => ({
  enable: vi.fn<() => void>(),
  redirect: vi.fn<(url: string) => never>((url) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; request headers and cookies exist only inside a Next request.
vi.mock("next/headers", () => ({
  draftMode: () => Promise.resolve({ enable: next.enable }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; redirect() throws Next's control-flow error outside a request.
vi.mock("next/navigation", () => ({ redirect: next.redirect }));

const SECRET = "preview-secret";

/** Signs a token the way the patronage-headless theme does (inc/preview.php). */
const sign = (payload: string, secret = SECRET) =>
  `${Buffer.from(payload).toString("base64url")}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;

const inTenMinutes = () => Math.floor(Date.now() / 1000) + 600;

const get = (token?: string) =>
  new Request(
    `https://site.example.org/api/preview${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`
  );

describe("GET /api/preview", () => {
  beforeEach(() => {
    vi.stubEnv("WORDPRESS_URL", "https://cms.example.org");
    vi.stubEnv("HEADLESS_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([
    ["no token", undefined],
    ["a malformed token", "not-a-token"],
    [
      "a token signed with another secret",
      sign(`42.${inTenMinutes()}`, "other"),
    ],
    ["an expired token", sign(`42.${Math.floor(Date.now() / 1000) - 1}`)],
  ])("answers 401 to %s without turning on draft mode", async (_, token) => {
    const response = await GET(get(token));

    expect(response.status).toBe(401);
    expect(next.enable).not.toHaveBeenCalled();
    expect(next.redirect).not.toHaveBeenCalled();
  });

  it("turns on draft mode and redirects to the post's preview page for a valid token", async () => {
    await expect(GET(get(sign(`42.${inTenMinutes()}`)))).rejects.toThrow(
      "NEXT_REDIRECT /preview/42/"
    );
    expect(next.enable).toHaveBeenCalledOnce();
  });
});
