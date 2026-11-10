import { describe, expect, it } from "vitest";

import { isLocalRequest } from "./local-login";

// What miniflare sends for a request made in the developer's own browser.
const LOCAL = {
  "cf-connecting-ip": "127.0.0.1",
  host: "localhost:5173",
  "x-forwarded-host": "localhost:5173",
};

describe(isLocalRequest, () => {
  it("accepts a request miniflare stamps as local", () => {
    expect(isLocalRequest(new Headers(LOCAL))).toBeTruthy();
  });

  it.each(["localhost", "localhost:3000", "127.0.0.1:8787", "[::1]:5173"])(
    "accepts host %s",
    (host) => {
      expect(isLocalRequest(new Headers({ host }))).toBeTruthy();
    }
  );

  it("accepts an IPv6 loopback address", () => {
    expect(
      isLocalRequest(new Headers({ ...LOCAL, "cf-connecting-ip": "::1" }))
    ).toBeTruthy();
  });

  it.each([
    ["no host", {}],
    ["a public host", { host: "cms.example.com" }],
    [
      "a host that only starts with localhost",
      { host: "localhost.example.com" },
    ],
    ["a host that cannot be parsed", { host: "local host" }],
  ])("refuses %s", (_name, headers) => {
    expect(isLocalRequest(new Headers(headers))).toBeFalsy();
  });

  it("refuses a visitor's address on a local host header", () => {
    expect(
      isLocalRequest(
        new Headers({ ...LOCAL, "cf-connecting-ip": "203.0.113.7" })
      )
    ).toBeFalsy();
  });

  it("refuses a request forwarded from a public host", () => {
    expect(
      isLocalRequest(
        new Headers({ ...LOCAL, "x-forwarded-host": "abc.trycloudflare.com" })
      )
    ).toBeFalsy();
  });

  it.each(["cf-ray", "cf-visitor", "forwarded", "x-forwarded-for"])(
    "refuses a request that passed a proxy and carries %s",
    (name) => {
      expect(
        isLocalRequest(new Headers({ ...LOCAL, [name]: "set" }))
      ).toBeFalsy();
    }
  );
});
