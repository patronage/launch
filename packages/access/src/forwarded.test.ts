import type { JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { hasForwardedJwt, verifyForwardedUser } from "./forwarded.ts";
import { computeGatewayProof } from "./gateway-proof.ts";
import { AUD, TEAM_DOMAIN, signToken, testKeys } from "./test-keys.ts";

describe(verifyForwardedUser, () => {
  let keys: Awaited<ReturnType<typeof testKeys>>;

  beforeAll(async () => {
    keys = await testKeys();
  });

  const config = (proofSecret = "proof-secret") => ({
    audience: AUD,
    getKey: keys.getKey,
    proofSecret,
    teamDomain: TEAM_DOMAIN,
  });

  const forwarded = async (
    claims: JWTPayload = {},
    proofSecret = "proof-secret"
  ) => {
    const jwt = await signToken(keys.privateKey, claims);

    return new Headers({
      "X-Access-Gateway-Proof": await computeGatewayProof(proofSecret, jwt),
      "X-Access-User-Jwt": jwt,
    });
  };

  it("returns the editor for a forwarded JWT with a valid proof", async () => {
    const headers = await forwarded({ email: "Editor@Example.com" });

    await expect(verifyForwardedUser(headers, config())).resolves.toMatchObject(
      { email: "editor@example.com", ok: true, subject: "access-subject" }
    );
  });

  it("refuses a request with no forwarded JWT", async () => {
    await expect(
      verifyForwardedUser(new Headers(), config())
    ).resolves.toStrictEqual({ ok: false, reason: "missing_token" });
  });

  it("refuses when no proof secret is configured", async () => {
    await expect(
      verifyForwardedUser(await forwarded(), config(""))
    ).resolves.toStrictEqual({ ok: false, reason: "not_configured" });
  });

  it("refuses a forwarded JWT without a proof", async () => {
    const headers = await forwarded();
    headers.delete("X-Access-Gateway-Proof");

    await expect(verifyForwardedUser(headers, config())).resolves.toStrictEqual(
      { ok: false, reason: "missing_proof" }
    );
  });

  it("refuses a proof signed with another secret", async () => {
    const headers = await forwarded({}, "another-secret");

    await expect(verifyForwardedUser(headers, config())).resolves.toStrictEqual(
      { ok: false, reason: "proof_signature" }
    );
  });

  it("refuses a JWT for another Access application", async () => {
    const headers = await forwarded();

    await expect(
      verifyForwardedUser(headers, { ...config(), audience: "another-aud" })
    ).resolves.toStrictEqual({ ok: false, reason: "invalid_token" });
  });

  it("refuses a service token, which names no person", async () => {
    const headers = await forwarded({
      common_name: "client-id.access",
      email: undefined,
    });

    await expect(verifyForwardedUser(headers, config())).resolves.toStrictEqual(
      { ok: false, reason: "service_token" }
    );
  });

  it("ignores the assertion header Access itself sets", async () => {
    const jwt = await signToken(keys.privateKey);

    const headers = new Headers({
      "Cf-Access-Jwt-Assertion": jwt,
      "X-Access-Gateway-Proof": await computeGatewayProof("proof-secret", jwt),
    });

    expect(hasForwardedJwt(headers)).toBeFalsy();
    await expect(verifyForwardedUser(headers, config())).resolves.toStrictEqual(
      { ok: false, reason: "missing_token" }
    );
  });
});
