import { describe, expect, it } from "vitest";

import {
  accessOptedOut,
  accessOptOutCookie,
  accessSignInEnabled,
  clearAccessOptOutCookie,
  isHttps,
} from "./access-opt-out";

describe(accessSignInEnabled, () => {
  it("is on only with both Access settings", () => {
    expect(
      accessSignInEnabled({
        ACCESS_AUD: "aud",
        ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      })
    ).toBeTruthy();
    expect(accessSignInEnabled({ ACCESS_AUD: "aud" })).toBeFalsy();
    expect(
      accessSignInEnabled({
        ACCESS_AUD: "",
        ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      })
    ).toBeFalsy();
  });
});

describe(accessOptedOut, () => {
  it("reads the opt-out cookie for the configured prefix", () => {
    const headers = new Headers({
      cookie: "payload-access-off=1; CF_Authorization=x",
    });

    expect(accessOptedOut(headers, "payload")).toBeTruthy();
    expect(accessOptedOut(headers, "launch")).toBeFalsy();
    expect(
      accessOptedOut(new Headers({ cookie: "CF_Authorization=x" }), "payload")
    ).toBeFalsy();
  });
});

describe(accessOptOutCookie, () => {
  it("is short-lived, HttpOnly and Lax, and Secure over HTTPS", () => {
    expect(accessOptOutCookie({ cookiePrefix: "payload", secure: true })).toBe(
      "payload-access-off=1; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax; Secure"
    );
    expect(
      accessOptOutCookie({ cookiePrefix: "payload", secure: false })
    ).not.toContain("Secure");
  });

  it("is cleared with the same attributes", () => {
    expect(
      clearAccessOptOutCookie({ cookiePrefix: "payload", secure: true })
    ).toBe(
      "payload-access-off=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure"
    );
  });
});

describe(isHttps, () => {
  it("checks the request URL's scheme", () => {
    expect(isHttps("https://cms.example.com/api/users/logout")).toBeTruthy();
    expect(isHttps("http://localhost:4173/api/users/logout")).toBeFalsy();
    expect(isHttps(undefined)).toBeFalsy();
  });
});
