import { computeGatewayProof } from "@patronage/access";
import {
  MAX_LOGGED_UPSTREAM_REQUESTS,
  UpstreamRequestError,
  assertSafeApiUrl,
  createUpstreamTelemetry,
  upstreamAuthHeaders,
} from "@patronage/mcp-core";
import type {
  McpWideEvent,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { createLogger } from "evlog";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WordPressEnv } from "./env";
import {
  boundedWordPressErrorCode,
  createWordPressClient,
  resolveWpUrl,
  wordPressErrorMessage,
  wpFetch,
  wpGraphql,
  inspectWordPressResponse,
} from "./wordpress";

const client: UpstreamClient = {
  apiUrl: "https://wordpress.example",
  auth: { kind: "access-jwt", token: "signed-access-jwt" },
  connector: "wp",
  inspect: inspectWordPressResponse,
  label: "WordPress",
};

const workerEnv: WordPressEnv = {
  ACCESS_AUD: "replace-me",
  ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  DEPLOYMENT_ENVIRONMENT: "test",
  WORDPRESS_API_URL: "https://wordpress.example",
};

describe("WordPress URL safety", () => {
  it("requires HTTPS outside loopback hosts", () => {
    expect(assertSafeApiUrl("https://wordpress.example").protocol).toBe(
      "https:"
    );
    expect(assertSafeApiUrl("http://localhost:8080").hostname).toBe(
      "localhost"
    );
    expect(assertSafeApiUrl("http://127.0.0.1").hostname).toBe("127.0.0.1");
    expect(() => assertSafeApiUrl("http://wordpress.example")).toThrow(
      UpstreamRequestError
    );
  });

  it("keeps requests on the configured origin under /wp-json/", () => {
    const url = resolveWpUrl(
      client.apiUrl,
      "/wp-json/wp/v2/users/me?context=edit"
    );

    expect(url.origin).toBe("https://wordpress.example");
    expect(url.pathname).toBe("/wp-json/wp/v2/users/me");
    expect(url.search).toBe("?context=edit");

    expect(() =>
      resolveWpUrl(client.apiUrl, "https://evil.example/wp-json/wp/v2/users/me")
    ).toThrow(UpstreamRequestError);
    expect(() => resolveWpUrl(client.apiUrl, "/wp/v2/users/me")).toThrow(
      UpstreamRequestError
    );
  });
});

describe("WordPress client authentication", () => {
  it("forwards the caller's Access JWT and holds no WordPress credentials", () => {
    expect(
      createWordPressClient(workerEnv, {
        ok: true,
        subjectOpaque: "opaque",
        token: "signed-access-jwt",
      })
    ).toStrictEqual(client);
    expect(
      createWordPressClient(
        { ...workerEnv, WORDPRESS_ACCESS_PROOF_SECRET: "shared-secret" },
        { ok: true, subjectOpaque: "opaque", token: "signed-access-jwt" }
      )
    ).toStrictEqual({
      apiUrl: "https://wordpress.example",
      auth: {
        kind: "access-jwt",
        proofSecret: "shared-secret",
        token: "signed-access-jwt",
      },
      connector: "wp",
      inspect: inspectWordPressResponse,
      label: "WordPress",
    });
  });

  it("replaces every inbound authentication header with the forwarded JWT", () => {
    const headers = upstreamAuthHeaders(
      { kind: "access-jwt", token: "same-access-jwt" },
      {
        Authorization: "must-be-removed",
        "X-Access-Gateway-Proof": "must-be-removed",
        "X-Access-User-Jwt": "must-be-removed",
      }
    );

    expect(headers.get("X-Access-User-Jwt")).toBe("same-access-jwt");
    expect(headers.has("Authorization")).toBeFalsy();
    expect(headers.has("X-Access-Gateway-Proof")).toBeFalsy();
  });

  it("stamps the gateway proof beside the forwarded JWT only when computed", () => {
    const withProof = upstreamAuthHeaders(
      { kind: "access-jwt", token: "same-access-jwt" },
      { "X-Access-Gateway-Proof": "must-be-removed" },
      "t=1,v1=abc"
    );

    expect(withProof.get("X-Access-Gateway-Proof")).toBe("t=1,v1=abc");

    const withoutProof = upstreamAuthHeaders({
      kind: "access-jwt",
      token: "same-access-jwt",
    });

    expect(withoutProof.has("X-Access-Gateway-Proof")).toBeFalsy();
  });

  it("computes the gateway proof matching the mu-plugin known-answer vector", async () => {
    // Shared verbatim with wordpress/tests/verify.test.php so the Worker and
    // PHP implementations cannot drift.
    await expect(
      computeGatewayProof("proof-test-secret", "aaa.bbb.ccc", 1_700_000_000)
    ).resolves.toBe(
      "t=1700000000,v1=1c8f01bed0503f0d5e251595bb5d22c4139dbf1db58b43f63c5d8463d26aa227"
    );
  });

  it("maps authentication failures and bounds safe error codes", () => {
    expect(wordPressErrorMessage(403, "patronage_access_no_user")).toContain(
      "No WordPress account matches"
    );
    expect(wordPressErrorMessage(403, "rest_forbidden")).toContain(
      "does not have permission"
    );
    expect(wordPressErrorMessage(401, "unexpected_code")).toBe(
      "WordPress did not accept the request's authentication."
    );
    expect(boundedWordPressErrorCode("a".repeat(100))).toHaveLength(64);
    expect(boundedWordPressErrorCode("person@example.com")).toBeUndefined();
  });
});

describe(wpFetch, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("forwards the JWT, refuses redirects, and records a path without its query", async () => {
    let captured: Request | undefined;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);

      return Response.json(
        { id: 1 },
        {
          headers: {
            "X-Access-WordPress-User-ID": "42",
            "X-Access-WordPress-User-Slug": "editor",
            "X-WP-Total": "7",
            "X-WP-TotalPages": "1",
          },
        }
      );
    });

    const log = createLogger<McpWideEvent>();
    const telemetry = createUpstreamTelemetry(log);

    const result = await wpFetch(
      client,
      "/wp-json/wp/v2/users/me?context=edit",
      telemetry
    );

    expect(result).toMatchObject({ status: 200, totalItems: 7, totalPages: 1 });
    expect({
      defined: captured !== undefined,
      forwardedJwt: captured?.headers.get("X-Access-User-Jwt"),
      hasAuthorization: captured?.headers.has("Authorization"),
      redirect: captured?.redirect,
    }).toStrictEqual({
      defined: true,
      forwardedJwt: "signed-access-jwt",
      hasAuthorization: false,
      redirect: "manual",
    });
    expect({
      sensitiveDataPresent:
        /Authorization|context=edit|signed-access-jwt/u.test(
          JSON.stringify(log.getContext())
        ),
      telemetry: telemetry.requests,
      upstream: log.getContext().upstream,
    }).toStrictEqual({
      sensitiveDataPresent: false,
      telemetry: [
        expect.objectContaining({
          method: "GET",
          outcome: "ok",
          path: "/wp-json/wp/v2/users/me",
          status: 200,
        }),
      ],
      upstream: {
        actor: { id: 42, slug: "editor" },
        auth: "access-jwt",
        requests: [
          {
            connector: "wp",
            durationMs: expect.any(Number),
            method: "GET",
            outcome: "success",
            path: "/wp-json/wp/v2/users/me",
            status: 200,
          },
        ],
        target: "wordpress.example",
      },
    });
  });

  it("stamps a gateway proof bound to the forwarded JWT when a secret is set", async () => {
    let captured: Request | undefined;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init);

      return Response.json({ id: 1 });
    });

    await wpFetch(
      {
        apiUrl: client.apiUrl,
        auth: {
          kind: "access-jwt",
          proofSecret: "shared-secret",
          token: "signed-access-jwt",
        },
      },
      "/wp-json/wp/v2/users/me",
      createUpstreamTelemetry()
    );

    expect(captured?.headers.get("X-Access-Gateway-Proof")).toMatch(
      /^t=\d+,v1=[0-9a-f]{64}$/u
    );
  });
});

describe(wpGraphql, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the site origin's /graphql with the forwarded token", async () => {
    let seen: { headers: Headers; url: string } | undefined;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), url: String(input) };

      return Response.json({ data: { __typename: "RootQuery" } });
    });

    const json = await wpGraphql(
      client,
      "{ __typename }",
      undefined,
      createUpstreamTelemetry()
    );

    expect(json).toStrictEqual({ data: { __typename: "RootQuery" } });
    expect(seen?.url).toBe("https://wordpress.example/graphql");
    expect(seen?.headers.get("X-Access-User-Jwt")).toBe("signed-access-jwt");
  });

  it("raises a bounded error when WPGraphQL rejects the token", async () => {
    vi.stubGlobal("fetch", () =>
      Response.json(
        { code: "patronage_access_invalid_token", message: "raw upstream" },
        { status: 401 }
      )
    );

    await expect(
      wpGraphql(client, "{ __typename }", undefined, createUpstreamTelemetry())
    ).rejects.toThrow(
      "WordPress rejected the Access token. Reconnect the MCP client and retry."
    );
  });
});

// The cap keeps the records that arrived first, so the requests have to be
// made one after another; the recursion mirrors how apply.ts sequences its own
// per-operation fetches.
const fetchPages = async (
  telemetry: UpstreamTelemetry,
  count: number,
  index: number
): Promise<void> => {
  if (index >= count) {
    return;
  }

  await wpFetch(client, `/wp-json/wp/v2/pages/${index}`, telemetry);
  await fetchPages(telemetry, count, index + 1);
};

describe("collected WordPress request records", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the first fifty records and counts the rest as truncated", async () => {
    vi.stubGlobal("fetch", () => Response.json({ id: 1 }));
    const telemetry = createUpstreamTelemetry();
    const overflow = 3;

    await fetchPages(telemetry, MAX_LOGGED_UPSTREAM_REQUESTS + overflow, 0);

    expect({
      first: telemetry.upstream?.requests.at(0)?.path,
      kept: telemetry.upstream?.requests.length,
      last: telemetry.upstream?.requests.at(-1)?.path,
      truncated: telemetry.upstream?.truncated,
    }).toStrictEqual({
      first: "/wp-json/wp/v2/pages/0",
      kept: MAX_LOGGED_UPSTREAM_REQUESTS,
      last: `/wp-json/wp/v2/pages/${MAX_LOGGED_UPSTREAM_REQUESTS - 1}`,
      truncated: overflow,
    });
  });

  it("records no request body and no query string", async () => {
    vi.stubGlobal("fetch", () => Response.json({ id: 1 }));
    const telemetry = createUpstreamTelemetry();

    await wpFetch(client, "/wp-json/wp/v2/pages/7?context=edit", telemetry, {
      body: JSON.stringify({ title: "secret draft title" }),
      method: "POST",
    });

    expect(JSON.stringify(telemetry.upstream)).not.toContain("secret draft");
    expect(telemetry.upstream?.requests.at(0)).toMatchObject({
      method: "POST",
      path: "/wp-json/wp/v2/pages/7",
    });
  });
});
