import { describe, expect, it, vi } from "vitest";

import { shouldDeferToPayload } from "./payload-credential";

const valid = () => Promise.resolve(true);
const invalid = () => Promise.resolve(false);

describe(shouldDeferToPayload, () => {
  it("defers to Payload for an Authorization header", async () => {
    const check = vi.fn<() => Promise<boolean>>(invalid);

    await expect(
      shouldDeferToPayload(
        new Headers({ authorization: "JWT abc" }),
        "payload",
        check
      )
    ).resolves.toBeTruthy();
    expect(check).not.toHaveBeenCalled();
  });

  it("defers to Payload for a payload-token cookie that verifies", async () => {
    await expect(
      shouldDeferToPayload(
        new Headers({ cookie: "payload-token=current; CF_Authorization=x" }),
        "payload",
        valid
      )
    ).resolves.toBeTruthy();
  });

  it("does not defer for a stale payload-token cookie", async () => {
    await expect(
      shouldDeferToPayload(
        new Headers({ cookie: "payload-token=expired; CF_Authorization=x" }),
        "payload",
        invalid
      )
    ).resolves.toBeFalsy();
  });

  it("does not check a session when there is no Payload cookie", async () => {
    const check = vi.fn<() => Promise<boolean>>(valid);

    await expect(
      shouldDeferToPayload(
        new Headers({ cookie: "CF_Authorization=x" }),
        "payload",
        check
      )
    ).resolves.toBeFalsy();
    expect(check).not.toHaveBeenCalled();
  });

  it("uses the configured cookie prefix", async () => {
    await expect(
      shouldDeferToPayload(
        new Headers({ cookie: "payload-token=current" }),
        "launch",
        valid
      )
    ).resolves.toBeFalsy();
  });
});
