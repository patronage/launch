import { describe, expect, it, vi } from "vitest";

import {
  ACCESS_LOGOUT_PATH,
  accessSignInEnabled,
  logOutOfPayloadAndAccess,
} from "./access-logout";

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
    expect(accessSignInEnabled({})).toBeFalsy();
  });
});

describe(logOutOfPayloadAndAccess, () => {
  it("ends the Payload session before the Access session", async () => {
    const order: string[] = [];

    const logOut = vi.fn<() => Promise<boolean>>(() => {
      order.push("payload");

      return Promise.resolve(true);
    });

    const navigate = vi.fn<(url: string) => void>((url) => {
      order.push(url);
    });

    await logOutOfPayloadAndAccess(logOut, navigate);

    expect(order).toStrictEqual(["payload", ACCESS_LOGOUT_PATH]);
  });

  it("still ends the Access session when Payload's logout fails", async () => {
    const navigate = vi.fn<(url: string) => void>();

    await logOutOfPayloadAndAccess(
      () => Promise.reject(new Error("No user")),
      navigate
    );

    expect(navigate).toHaveBeenCalledWith(ACCESS_LOGOUT_PATH);
  });
});
