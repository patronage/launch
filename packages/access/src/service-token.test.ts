import { describe, expect, it, vi } from "vitest";

import { verifyGatewayProof } from "./gateway-proof.ts";
import {
  accessFetch,
  accessRequestHeaders,
  isAccessRejection,
  serviceTokenHeaders,
} from "./service-token.ts";

const serviceToken = {
  clientId: "client-id.access",
  clientSecret: "client-secret",
};

describe("service tokens", () => {
  describe(serviceTokenHeaders, () => {
    it("sets the Access client headers", () => {
      const headers = serviceTokenHeaders(serviceToken);

      expect(headers.get("CF-Access-Client-Id")).toBe("client-id.access");
      expect(headers.get("CF-Access-Client-Secret")).toBe("client-secret");
    });

    it("refuses an unconfigured token", () => {
      expect(() =>
        serviceTokenHeaders({ clientId: "", clientSecret: "x" })
      ).toThrow(/not configured/u);
    });
  });

  describe(accessRequestHeaders, () => {
    it("replaces caller-supplied Access headers", async () => {
      const headers = await accessRequestHeaders(
        {
          Accept: "application/json",
          "CF-Access-Client-Id": "spoofed",
          "X-Access-Gateway-Proof": "spoofed",
          "X-Access-User-Jwt": "spoofed",
        },
        { serviceToken }
      );

      expect(headers.get("CF-Access-Client-Id")).toBe("client-id.access");
      expect(headers.has("X-Access-User-Jwt")).toBeFalsy();
      expect(headers.has("X-Access-Gateway-Proof")).toBeFalsy();
      expect(headers.get("Accept")).toBe("application/json");
    });

    it("forwards a user JWT with a verifiable proof", async () => {
      const headers = await accessRequestHeaders(undefined, {
        forward: { jwt: "aaa.bbb.ccc", proofSecret: "proof-secret" },
        serviceToken,
      });

      const proof = headers.get("X-Access-Gateway-Proof") ?? "";

      expect(headers.get("X-Access-User-Jwt")).toBe("aaa.bbb.ccc");
      await expect(
        verifyGatewayProof(proof, "aaa.bbb.ccc", "proof-secret")
      ).resolves.not.toBeTypeOf("string");
    });

    it("forwards a JWT without a proof when no secret is set", async () => {
      const headers = await accessRequestHeaders(undefined, {
        forward: { jwt: "aaa.bbb.ccc" },
        serviceToken,
      });

      expect(headers.has("X-Access-Gateway-Proof")).toBeFalsy();
    });
  });

  describe(accessFetch, () => {
    it("sends the service token and does not follow redirects", async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("{}"))
      );

      await accessFetch(
        "https://cms.example.org/graphql",
        { method: "POST" },
        { fetch: fetchMock, serviceToken }
      );
      const [, init] = fetchMock.mock.calls[0] ?? [];

      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("CF-Access-Client-Secret")).toBe(
        "client-secret"
      );
    });
  });

  describe(isAccessRejection, () => {
    it("recognizes a login redirect and auth errors", () => {
      const login = new Response(null, {
        headers: {
          Location:
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/cms.example.org",
        },
        status: 302,
      });

      const appRedirect = new Response(null, {
        headers: { Location: "/wp-admin/" },
        status: 302,
      });

      expect(isAccessRejection(login)).toBeTruthy();
      expect(
        isAccessRejection(new Response(null, { status: 403 }))
      ).toBeTruthy();
      expect(isAccessRejection(appRedirect)).toBeFalsy();
      expect(isAccessRejection(new Response("{}"))).toBeFalsy();
    });
  });
});
