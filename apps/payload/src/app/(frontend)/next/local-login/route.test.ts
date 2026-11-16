import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const admin = { email: "admin@example.org", id: 1 };

const payload = vi.hoisted(() => ({
  find: vi.fn<() => Promise<{ docs: { email: string; id: number }[] }>>(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; the real config needs Worker bindings.
vi.mock("@/lib/payload-config", () => ({
  getPayloadConfig: () => Promise.resolve({}),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; stands in for Payload, so the test needs no database.
vi.mock("payload", () => ({
  createPayloadRequest: () => Promise.resolve({}),
  getFieldsToSign: (args: { email: string }) => ({ email: args.email }),
  getPayload: () =>
    Promise.resolve({
      collections: {
        users: { config: { auth: { tokenExpiration: 7200 } } },
      },
      config: { cookiePrefix: "payload" },
      find: payload.find,
      secret: "test-payload-secret",
    }),
  jwtSign: () => Promise.resolve({ token: "signed-token" }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; the cookie helper reads the stand-in Payload config.
vi.mock("payload/shared", () => ({
  addSessionToUser: () => Promise.resolve({ sid: "session-1" }),
  generatePayloadCookie: ({ token }: { token: string }) =>
    `payload-token=${token}; Path=/; HttpOnly`,
}));

// What miniflare sends for a request made in the developer's own browser.
const LOCAL = {
  "cf-connecting-ip": "127.0.0.1",
  host: "localhost:5173",
  "x-forwarded-host": "localhost:5173",
};

const post = (headers: Record<string, string>) =>
  // SAFETY: the handler reads only the request's headers.
  new Request("http://localhost:5173/next/local-login", {
    headers,
    method: "POST",
  }) as NextRequest;

describe("POST /next/local-login", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["a deployed host", { host: "site.example.org" }],
    [
      "a request through Cloudflare's edge",
      { ...LOCAL, "cf-ray": "8a1b2c3d4e5f-LHR" },
    ],
    ["a visitor's address", { ...LOCAL, "cf-connecting-ip": "203.0.113.9" }],
  ])("answers 404 to %s", async (_, headers) => {
    const response = await POST(post(headers));

    expect(response.status).toBe(404);
    expect(response.headers.has("set-cookie")).toBeFalsy();
    expect(payload.find).not.toHaveBeenCalled();
  });

  it.each(["cross-site", "same-site", "none"])(
    "answers 403 when Sec-Fetch-Site is %s",
    async (site) => {
      const response = await POST(post({ ...LOCAL, "sec-fetch-site": site }));

      expect(response.status).toBe(403);
      expect(response.headers.has("set-cookie")).toBeFalsy();
      expect(payload.find).not.toHaveBeenCalled();
    }
  );

  it("answers 404 when there is no admin user to sign in as", async () => {
    payload.find.mockResolvedValue({ docs: [] });

    const response = await POST(
      post({ ...LOCAL, "sec-fetch-site": "same-origin" })
    );

    expect(response.status).toBe(404);
    expect(response.headers.has("set-cookie")).toBeFalsy();
  });

  it("signs in as the first admin and opens the admin", async () => {
    payload.find.mockResolvedValue({ docs: [admin] });

    const response = await POST(
      post({ ...LOCAL, "sec-fetch-site": "same-origin" })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");
    expect(response.headers.get("set-cookie")).toContain(
      "payload-token=signed-token"
    );
  });
});
