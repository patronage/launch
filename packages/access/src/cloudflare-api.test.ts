import { describe, expect, it, vi } from "vitest";

import {
  applicationBody,
  cloudflareClient,
  ensureApplication,
  provisionLockdown,
} from "./cloudflare-api.ts";
import type { RequestBody } from "./cloudflare-api.ts";

interface Call {
  method: string;
  path: string;
  body: RequestBody | undefined;
}

type Route = (body: RequestBody | undefined) => object;

const fakeApi = (routes: Record<string, Route>) => {
  const calls: Call[] = [];

  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));

    const path =
      url.pathname.replace("/client/v4/accounts/acct", "") + url.search;

    const method = init?.method ?? "GET";

    // SAFETY: the client under test only ever sends JSON-encoded RequestBody values.
    const body: RequestBody | undefined = init?.body
      ? JSON.parse(String(init.body))
      : undefined;

    calls.push({ body, method, path });
    const route = routes[`${method} ${path}`];

    if (!route) {
      return Promise.resolve(
        Response.json(
          {
            errors: [{ code: 404, message: `no route ${method} ${path}` }],
            success: false,
          },
          { status: 404 }
        )
      );
    }

    return Promise.resolve(
      Response.json({ result: route(body), success: true })
    );
  });

  return {
    calls,
    client: cloudflareClient({
      accountId: "acct",
      apiToken: "token",
      fetch: fetchMock,
    }),
  };
};

const decisionOf = (body: RequestBody | undefined) =>
  body && "decision" in body ? body.decision : undefined;

describe("cloudflare access api", () => {
  describe(provisionLockdown, () => {
    it("creates a service token, two policies and the application", async () => {
      const { calls, client } = fakeApi({
        "GET /access/apps?page=1&per_page=50": () => [],
        "GET /access/organizations": () => ({
          auth_domain: "team.cloudflareaccess.com",
        }),
        "GET /access/policies?page=1&per_page=50": () => [],
        "GET /access/service_tokens?name=web%20worker": () => [],
        "POST /access/apps": () => ({ aud: "new-aud", id: "app-1" }),
        "POST /access/policies": (body) => ({
          id: decisionOf(body) === "allow" ? "pol-editors" : "pol-tokens",
        }),
        "POST /access/service_tokens": () => ({
          client_id: "cid.access",
          client_secret: "secret",
          id: "tok-1",
        }),
      });

      const result = await provisionLockdown(client, {
        allowEmailDomains: ["example.org"],
        destinations: ["cms.example.org/admin", "cms.example.org/api"],
        name: "Demo Payload",
        serviceTokens: ["web worker"],
      });

      expect(result).toStrictEqual({
        applicationId: "app-1",
        aud: "new-aud",
        serviceTokens: [
          {
            clientId: "cid.access",
            clientSecret: "secret",
            id: "tok-1",
            name: "web worker",
          },
        ],
        teamDomain: "https://team.cloudflareaccess.com",
      });

      const tokenPolicy = calls.find(
        (call) =>
          call.method === "POST" && decisionOf(call.body) === "non_identity"
      );

      const app = calls.find(
        (call) => call.method === "POST" && call.path === "/access/apps"
      );

      expect(tokenPolicy?.body).toMatchObject({
        include: [{ service_token: { token_id: "tok-1" } }],
      });
      expect(app?.body).toMatchObject({
        destinations: [
          { type: "public", uri: "cms.example.org/admin" },
          { type: "public", uri: "cms.example.org/api" },
        ],
        policies: [
          { id: "pol-editors", precedence: 1 },
          { id: "pol-tokens", precedence: 2 },
        ],
        type: "self_hosted",
      });
    });

    it("updates existing resources by name and never re-reveals a token secret", async () => {
      const { calls, client } = fakeApi({
        "GET /access/apps?page=1&per_page=50": () => [
          { id: "app-1", name: "Demo WordPress" },
        ],
        "GET /access/organizations": () => ({
          auth_domain: "team.cloudflareaccess.com",
        }),
        "GET /access/policies?page=1&per_page=50": () => [
          { id: "pol-tokens", name: "Demo WordPress service tokens" },
        ],
        "GET /access/service_tokens?name=web": () => [
          { client_id: "cid.access", id: "tok-1", name: "web" },
        ],
        "PUT /access/apps/app-1": () => ({ aud: "same-aud", id: "app-1" }),
        "PUT /access/policies/pol-tokens": () => ({ id: "pol-tokens" }),
      });

      const result = await provisionLockdown(client, {
        destinations: ["cms.example.org"],
        name: "Demo WordPress",
        serviceTokens: ["web"],
      });

      expect(result.serviceTokens).toStrictEqual([
        { clientId: "cid.access", id: "tok-1", name: "web" },
      ]);
      expect(calls.filter((call) => call.method === "POST")).toStrictEqual([]);
    });

    it("refuses a lockdown that would admit nobody", async () => {
      const { client } = fakeApi({});

      await expect(
        provisionLockdown(client, {
          destinations: ["cms.example.org"],
          name: "Empty",
        })
      ).rejects.toThrow(/at least one/u);
    });

    it("reports a new token before a later step fails", async () => {
      const heard: unknown[] = [];

      const { client } = fakeApi({
        "GET /access/service_tokens?name=web": () => [],
        "POST /access/service_tokens": () => ({
          client_id: "cid.access",
          client_secret: "secret",
          expires_at: "2027-11-09T00:00:00Z",
          id: "tok-1",
        }),
      });

      await expect(
        provisionLockdown(
          client,
          {
            destinations: ["cms.example.org"],
            name: "Broken",
            serviceTokens: ["web"],
          },
          { onServiceToken: (token) => heard.push(token) }
        )
      ).rejects.toThrow(/no route GET/u);

      expect(heard).toStrictEqual([
        {
          clientId: "cid.access",
          clientSecret: "secret",
          expiresAt: "2027-11-09T00:00:00Z",
          id: "tok-1",
          name: "web",
        },
      ]);
    });

    it("creates nothing for a lockdown that would admit nobody", async () => {
      const { calls, client } = fakeApi({});

      await expect(
        provisionLockdown(client, {
          destinations: ["cms.example.org"],
          name: "Empty",
          serviceTokens: [],
        })
      ).rejects.toThrow(/at least one/u);
      expect(calls).toStrictEqual([]);
    });

    it("surfaces API errors", async () => {
      const { client } = fakeApi({});

      await expect(
        provisionLockdown(client, {
          destinations: ["cms.example.org"],
          name: "Broken",
          serviceTokens: ["web"],
        })
      ).rejects.toThrow(/no route GET/u);
    });
  });

  describe(applicationBody, () => {
    it("needs a destination", () => {
      expect(() =>
        applicationBody({ destinations: [], name: "x" }, [])
      ).toThrow(/destination/u);
    });
  });

  it("finds an application on a later page instead of creating it again", async () => {
    const paths: string[] = [];

    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/client/v4/accounts/acct", "");
      const page = Number(url.searchParams.get("page") ?? 1);

      paths.push(`${init?.method ?? "GET"} ${path}${url.search}`);

      if (path === "/access/apps" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          Response.json({
            result:
              page === 1
                ? [{ id: "app-0", name: "Other" }]
                : [{ id: "app-2", name: "Demo WordPress" }],
            result_info: { page, total_pages: 2 },
            success: true,
          })
        );
      }

      return Promise.resolve(
        Response.json({ result: { aud: "aud-2", id: "app-2" }, success: true })
      );
    });

    const client = cloudflareClient({
      accountId: "acct",
      apiToken: "token",
      fetch: fetchMock,
    });

    await expect(
      ensureApplication(
        client,
        { destinations: ["cms.example.org"], name: "Demo WordPress" },
        ["pol-1"]
      )
    ).resolves.toStrictEqual({ aud: "aud-2", id: "app-2" });
    expect(paths).toStrictEqual([
      "GET /access/apps?page=1&per_page=50",
      "GET /access/apps?page=2&per_page=50",
      "PUT /access/apps/app-2",
    ]);
  });

  it("pages by total_count when result_info has no total_pages", async () => {
    const paths: string[] = [];

    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/client/v4/accounts/acct", "");
      const page = Number(url.searchParams.get("page") ?? 1);

      paths.push(`${init?.method ?? "GET"} ${path}${url.search}`);

      if (path === "/access/apps" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          Response.json({
            result:
              page === 1
                ? [{ id: "app-0", name: "Other" }]
                : [{ id: "app-2", name: "Demo WordPress" }],
            result_info: { page, per_page: 1, total_count: 2 },
            success: true,
          })
        );
      }

      return Promise.resolve(
        Response.json({ result: { aud: "aud-2", id: "app-2" }, success: true })
      );
    });

    const client = cloudflareClient({
      accountId: "acct",
      apiToken: "token",
      fetch: fetchMock,
    });

    await expect(
      ensureApplication(
        client,
        { destinations: ["cms.example.org"], name: "Demo WordPress" },
        ["pol-1"]
      )
    ).resolves.toStrictEqual({ aud: "aud-2", id: "app-2" });
    expect(paths).toStrictEqual([
      "GET /access/apps?page=1&per_page=50",
      "GET /access/apps?page=2&per_page=50",
      "PUT /access/apps/app-2",
    ]);
  });
});
