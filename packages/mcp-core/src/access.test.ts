import { createLogger } from "evlog";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK, JWTPayload } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyAccess } from "./access";
import { withMcpRequestLog } from "./logging";
import type { McpWideEvent } from "./logging";

const ACCESS_TEAM_DOMAIN = "https://example.cloudflareaccess.com";
const ACCESS_AUD = "replace-me";

const env = (overrides: Partial<Env> = {}): Env => ({
  ACCESS_AUD,
  ACCESS_TEAM_DOMAIN,
  DEPLOYMENT_ENVIRONMENT: "test",
  WORDPRESS_API_URL: "https://wordpress.example",
  ...overrides,
});

const accessDeps = () => ({ log: createLogger<McpWideEvent>() });

const testKeys = async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";

  return { jwk, privateKey, publicKey };
};

const signToken = (
  privateKey: CryptoKey,
  claims: JWTPayload = {}
): Promise<string> =>
  new SignJWT({
    email: "editor@example.com",
    sub: "access-subject-placeholder",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(ACCESS_TEAM_DOMAIN)
    .setAudience(ACCESS_AUD)
    .sign(privateKey);

const request = (url: string, token?: string): Request => {
  const headers = new Headers();

  if (token) {
    headers.set("Cf-Access-Jwt-Assertion", token);
  }

  return new Request(url, { headers });
};

const stubJwks = (jwk: JWK): void => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/cdn-cgi/access/certs")) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  });
};

describe(verifyAccess, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("denies missing audience", async () => {
    const result = await verifyAccess(
      request("https://launch-mcp.example.com/mcp"),
      env({ ACCESS_AUD: "" }),
      accessDeps()
    );

    expect(result).toMatchObject({ ok: false, reason: "missing_audience" });
  });

  it("records an audit denial with an unknown actor and bounded target", async () => {
    const events: unknown[] = [];

    const worker = withMcpRequestLog(
      async (incoming, workerEnv, _ctx, log) => {
        const result = await verifyAccess(incoming, workerEnv, { log });

        return new Response("Forbidden", {
          status: result.ok ? 200 : result.status,
        });
      },
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    await worker.fetch(
      request("https://launch-mcp.example.com/mcp?token=must-not-appear"),
      { ...env(), ACCESS_AUD: "", DEPLOYMENT_ENVIRONMENT: "test" },
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      audit: {
        action: "mcp.authorize",
        actor: { id: "unknown", type: "user" },
        outcome: "denied",
        target: { id: "/mcp", type: "route" },
      },
      authentication: {
        actor: "unknown",
        outcome: "denied",
        reason: "missing_audience",
      },
      http: { status: 403 },
    });
    expect(JSON.stringify(events[0])).not.toContain("must-not-appear");
  });

  it("denies missing JWT", async () => {
    const result = await verifyAccess(
      request("https://launch-mcp.example.com/mcp"),
      env(),
      accessDeps()
    );

    expect(result).toMatchObject({ ok: false, reason: "missing_token" });
  });

  it("denies an invalid JWT", async () => {
    const result = await verifyAccess(
      request("https://launch-mcp.example.com/mcp", "not-a-jwt"),
      env(),
      accessDeps()
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("accepts a JWT signed for the placeholder audience and team issuer", async () => {
    const { privateKey, jwk } = await testKeys();
    const token = await signToken(privateKey);
    stubJwks(jwk);

    const result = await verifyAccess(
      request("https://launch-mcp.example.com/mcp", token),
      env(),
      accessDeps()
    );

    expect(result.ok).toBeTruthy();

    if (!result.ok) {
      throw new Error(`Expected access success, received ${result.reason}`);
    }

    expect(result.token).toBe(token);
    expect(result.subjectOpaque).toMatch(/^[a-f0-9]{16}$/u);
    expect(result.subjectOpaque).not.toContain("access-subject");
  });

  it("rejects a JWT with the wrong audience", async () => {
    const { privateKey, jwk } = await testKeys();

    const token = await new SignJWT({ sub: "access-subject-placeholder" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer(ACCESS_TEAM_DOMAIN)
      .setAudience("some-other-aud")
      .sign(privateKey);

    stubJwks(jwk);

    const result = await verifyAccess(
      request("https://launch-mcp.example.com/mcp", token),
      env(),
      accessDeps()
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("records an opaque actor without the raw subject or email", async () => {
    const events: unknown[] = [];
    const { privateKey, jwk } = await testKeys();

    const token = await signToken(privateKey, {
      email: "user@example.com",
      sub: "raw-subject-must-not-appear",
    });

    stubJwks(jwk);

    const worker = withMcpRequestLog(
      async (incoming, workerEnv, _ctx, log) => {
        // packages/access caches each team's remote key set for the life of
        // the isolate, so a test with fresh keys hands them over directly.
        const result = await verifyAccess(incoming, workerEnv, {
          getKey: createLocalJWKSet({ keys: [jwk] }),
          log,
        });

        return new Response("ok", { status: result.ok ? 200 : result.status });
      },
      {
        drain: ({ event }) => {
          events.push(event);
        },
      }
    );

    await worker.fetch(
      request("https://launch-mcp.example.com/mcp", token),
      env(),
      { waitUntil: vi.fn<(promise: Promise<unknown>) => void>() }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      authentication: {
        actor: expect.stringMatching(/^[a-f0-9]{16}$/u),
        outcome: "allowed",
      },
    });
    expect(JSON.stringify(events[0])).not.toContain(
      "raw-subject-must-not-appear"
    );
    expect(JSON.stringify(events[0])).not.toContain("user@example.com");
  });
});
