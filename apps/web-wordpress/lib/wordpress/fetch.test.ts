import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { wordpressFetch } from "./fetch";

const graphqlUrl = "https://cms.example.org/graphql";

describe("WordPress Access transport", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let issuer: string;

  const cmsCalls = () =>
    fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("https://cms.example.org/")
    );

  const token = (claims: JWTPayload) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("preview-audience")
      .setExpirationTime("5m")
      .sign(keys.privateKey);

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
  });

  beforeEach(async () => {
    issuer = `https://${crypto.randomUUID()}.cloudflareaccess.com`;
    vi.stubEnv("WORDPRESS_URL", "https://cms.example.org");
    vi.stubEnv("WORDPRESS_ACCESS_CLIENT_ID", "demo-client-id");
    vi.stubEnv("WORDPRESS_ACCESS_CLIENT_SECRET", "demo-client-secret");
    vi.stubEnv("WORDPRESS_ACCESS_PROOF_SECRET", "demo-proof-secret");
    vi.stubEnv("ACCESS_TEAM_DOMAIN", issuer);
    vi.stubEnv("ACCESS_PREVIEW_AUD", "preview-audience");
    vi.stubGlobal("fetch", fetchMock);

    const jwk = {
      ...(await exportJWK(keys.publicKey)),
      alg: "RS256",
      kid: "test-key",
    };

    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        String(url) === `${issuer}/cdn-cgi/access/certs`
          ? Response.json({ keys: [jwk] })
          : new Response("ok")
      )
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("authenticates public reads, strips forwarded identity and refuses redirects", async () => {
    await wordpressFetch(graphqlUrl, {
      headers: { "X-Access-User-Jwt": "untrusted" },
      method: "POST",
      redirect: "follow",
    });

    const init = cmsCalls()[0]?.[1];
    const headers = new Headers(init?.headers);

    expect(headers.get("CF-Access-Client-Id")).toBe("demo-client-id");
    expect(headers.get("CF-Access-Client-Secret")).toBe("demo-client-secret");
    expect(headers.has("X-Access-User-Jwt")).toBeFalsy();
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("POST");
  });

  it("uses the same transport for original CMS images", async () => {
    const url = "https://cms.example.org/wp-content/uploads/demo.jpg";

    await wordpressFetch(url);

    expect(cmsCalls()[0]?.[0]).toBe(url);
    expect(
      new Headers(cmsCalls()[0]?.[1]?.headers).get("CF-Access-Client-Secret")
    ).toBe("demo-client-secret");
  });

  it("verifies an editor JWT, adds a gateway proof and keeps previews uncached", async () => {
    const jwt = await token({ email: "editor@example.org", sub: "editor" });

    await wordpressFetch(graphqlUrl, { cache: "no-store" }, jwt);

    const init = cmsCalls()[0]?.[1];
    const headers = new Headers(init?.headers);

    expect(cmsCalls()).toHaveLength(1);
    expect(headers.get("X-Access-User-Jwt")).toBe(jwt);
    expect(headers.get("X-Access-Gateway-Proof")).toMatch(
      /^t=\d+,v1=[a-f0-9]{64}$/u
    );
    expect(init?.cache).toBe("no-store");
  });

  it("refuses invalid editor assertions before calling the CMS", async () => {
    await expect(wordpressFetch(graphqlUrl, {}, "forged")).rejects.toThrow(
      "verified Access user"
    );
    expect(cmsCalls()).toHaveLength(0);
  });

  it("does not let a service identity preview drafts", async () => {
    const jwt = await token({ common_name: "service" });

    await expect(wordpressFetch(graphqlUrl, {}, jwt)).rejects.toThrow(
      "verified Access user"
    );
    expect(cmsCalls()).toHaveLength(0);
  });

  it("rejects attempts to send CMS credentials to a different origin", async () => {
    await expect(
      wordpressFetch("https://other.example.org/graphql")
    ).rejects.toThrow("another origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows local development without Access and rejects incomplete service tokens", async () => {
    vi.stubEnv("WORDPRESS_ACCESS_CLIENT_ID", "");

    await expect(wordpressFetch(graphqlUrl)).rejects.toThrow("incomplete");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("WORDPRESS_ACCESS_CLIENT_SECRET", "");
    await wordpressFetch(graphqlUrl);

    expect(fetchMock).toHaveBeenCalledWith(graphqlUrl, {});
  });

  it("surfaces an Access login redirect instead of treating HTML as content", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          location: "https://team.cloudflareaccess.com/cdn-cgi/access/login",
        },
        status: 302,
      })
    );

    await expect(wordpressFetch(graphqlUrl)).rejects.toThrow("Access refused");
  });

  it("returns WordPress's own JSON 403 for the caller to handle", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ code: "rest_forbidden" }, { status: 403 })
    );

    const response = await wordpressFetch(graphqlUrl);

    expect(response.status).toBe(403);
  });
});
