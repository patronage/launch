import { describe, expect, it } from "vitest";

import { accessSessionExp, parseAccessStrategy } from "./access-session";

type Claims = Record<string, number | string>;

const base64url = (value: Claims) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// Only the payload matters: the strategy verified the signature already.
const jwt = (claims: Claims) =>
  `${base64url({ alg: "RS256" })}.${base64url(claims)}.signature`;

describe(parseAccessStrategy, () => {
  it("recognizes both Access strategies", () => {
    expect(parseAccessStrategy("cloudflare-access")).toBe("cloudflare-access");
    expect(parseAccessStrategy("cloudflare-access-gateway")).toBe(
      "cloudflare-access-gateway"
    );
  });

  it("does not claim Payload's own strategies", () => {
    expect(parseAccessStrategy("local-jwt")).toBeUndefined();
    expect(parseAccessStrategy(undefined)).toBeUndefined();
  });
});

describe(accessSessionExp, () => {
  it("reads exp from the Access assertion, not the payload-token cookie", () => {
    const headers = new Headers({
      "cf-access-jwt-assertion": jwt({ exp: 2_000_000_000 }),
      cookie: `payload-token=${jwt({ exp: 1 })}`,
    });

    expect(accessSessionExp(headers, "cloudflare-access")).toBe(2_000_000_000);
  });

  it("reads exp from the forwarded JWT for the gateway strategy", () => {
    const headers = new Headers({
      "x-access-user-jwt": jwt({ exp: 2_000_000_001 }),
    });

    expect(accessSessionExp(headers, "cloudflare-access-gateway")).toBe(
      2_000_000_001
    );
  });

  it("returns undefined without a token, or for a malformed one", () => {
    expect(
      accessSessionExp(new Headers(), "cloudflare-access")
    ).toBeUndefined();
    expect(
      accessSessionExp(
        new Headers({ "cf-access-jwt-assertion": "not-a-jwt" }),
        "cloudflare-access"
      )
    ).toBeUndefined();
  });
});
