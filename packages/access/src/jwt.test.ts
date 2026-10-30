import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  accessIssuer,
  accessJwksUrl,
  verifyAccessJwt,
  verifyAccessRequest,
} from "./jwt.ts";
import { AUD, signToken, TEAM_DOMAIN, testKeys } from "./test-keys.ts";

describe("access JWT", () => {
  let keys: Awaited<ReturnType<typeof testKeys>>;
  let otherKeys: Awaited<ReturnType<typeof testKeys>>;

  beforeAll(async () => {
    keys = await testKeys();
    otherKeys = await testKeys();
  });

  const config = () => ({
    audience: AUD,
    getKey: keys.getKey,
    teamDomain: TEAM_DOMAIN,
  });

  describe(verifyAccessJwt, () => {
    it("accepts a user login", async () => {
      const token = await signToken(keys.privateKey);

      await expect(verifyAccessJwt(token, config())).resolves.toMatchObject({
        identity: {
          email: "editor@example.com",
          kind: "user",
          subject: "access-subject",
        },
        ok: true,
      });
    });

    it("accepts a service token as a service identity", async () => {
      const token = await signToken(keys.privateKey, {
        common_name: "client-id.access",
        email: undefined,
        sub: "",
      });

      await expect(verifyAccessJwt(token, config())).resolves.toMatchObject({
        identity: { commonName: "client-id.access", kind: "service" },
        ok: true,
      });
    });

    it("accepts one of several audiences and a trailing slash on the team domain", async () => {
      const token = await signToken(keys.privateKey);

      const result = await verifyAccessJwt(token, {
        ...config(),
        audience: ["old-aud", AUD],
        teamDomain: `${TEAM_DOMAIN}/`,
      });

      expect(result.ok).toBeTruthy();
    });

    it.each([
      ["missing", null, "missing_token"],
      ["empty", "", "missing_token"],
      ["malformed", "one.two", "invalid_token"],
    ])("rejects a %s token", async (_name, token, reason) => {
      await expect(verifyAccessJwt(token, config())).resolves.toStrictEqual({
        ok: false,
        reason,
      });
    });

    it("rejects when not configured", async () => {
      const token = await signToken(keys.privateKey);
      const notConfigured = { ok: false, reason: "not_configured" };

      await expect(
        verifyAccessJwt(token, { ...config(), audience: [] })
      ).resolves.toStrictEqual(notConfigured);
      await expect(
        verifyAccessJwt(token, { ...config(), teamDomain: "" })
      ).resolves.toStrictEqual(notConfigured);
    });

    it("rejects the wrong audience, issuer or key", async () => {
      const token = await signToken(keys.privateKey);
      const foreign = await signToken(otherKeys.privateKey);
      const invalid = { ok: false, reason: "invalid_token" };

      await expect(
        verifyAccessJwt(token, { ...config(), audience: "other" })
      ).resolves.toStrictEqual(invalid);
      await expect(
        verifyAccessJwt(token, {
          ...config(),
          teamDomain: "https://other.cloudflareaccess.com",
        })
      ).resolves.toStrictEqual(invalid);
      await expect(verifyAccessJwt(foreign, config())).resolves.toStrictEqual(
        invalid
      );
    });

    it("applies a 60 second leeway to expiry", async () => {
      const now = Math.floor(Date.now() / 1000);
      const withinLeeway = await signToken(keys.privateKey, {}, now - 30);
      const pastLeeway = await signToken(keys.privateKey, {}, now - 120);
      const result = await verifyAccessJwt(withinLeeway, config());

      expect(result.ok).toBeTruthy();
      await expect(
        verifyAccessJwt(pastLeeway, config())
      ).resolves.toStrictEqual({ ok: false, reason: "expired" });
    });

    it("rejects a token with no identity claim", async () => {
      const token = await signToken(keys.privateKey, { email: "not-an-email" });

      await expect(verifyAccessJwt(token, config())).resolves.toStrictEqual({
        ok: false,
        reason: "invalid_token",
      });
    });

    it("rejects HS256", async () => {
      const token = await new SignJWT({ email: "editor@example.com" })
        .setProtectedHeader({ alg: "HS256", kid: "primary" })
        .setExpirationTime("5m")
        .setIssuer(TEAM_DOMAIN)
        .setAudience(AUD)
        .sign(new TextEncoder().encode("shared-secret-shared-secret-shared"));

      await expect(verifyAccessJwt(token, config())).resolves.toStrictEqual({
        ok: false,
        reason: "invalid_token",
      });
    });

    it("rejects a token without exp", async () => {
      const token = await new SignJWT({ email: "editor@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "primary" })
        .setIssuer(TEAM_DOMAIN)
        .setAudience(AUD)
        .sign(keys.privateKey);

      await expect(verifyAccessJwt(token, config())).resolves.toStrictEqual({
        ok: false,
        reason: "invalid_token",
      });
    });
  });

  describe(verifyAccessRequest, () => {
    it("reads the Cf-Access-Jwt-Assertion header", async () => {
      const request = new Request("https://cms.example.org/graphql", {
        headers: {
          "Cf-Access-Jwt-Assertion": await signToken(keys.privateKey),
        },
      });

      const result = await verifyAccessRequest(request, config());

      expect(result.ok).toBeTruthy();
    });
  });

  describe("issuer helpers", () => {
    it("normalizes the team domain", () => {
      expect(accessIssuer(" https://team.cloudflareaccess.com// ")).toBe(
        TEAM_DOMAIN
      );
      expect(accessJwksUrl(TEAM_DOMAIN).href).toBe(
        `${TEAM_DOMAIN}/cdn-cgi/access/certs`
      );
    });
  });
});
