import { beforeAll, describe, expect, it, vi } from "vitest";

import { accessAuthStrategy } from "./payload.ts";
import type { PayloadUserLookup } from "./payload.ts";
import { AUD, signToken, TEAM_DOMAIN, testKeys } from "./test-keys.ts";

interface TestUser {
  id: number;
  email: string;
}

const fakePayload = (docs: TestUser[]) => ({
  find: vi.fn<PayloadUserLookup<TestUser>["find"]>(() =>
    Promise.resolve({ docs })
  ),
});

describe(accessAuthStrategy, () => {
  let keys: Awaited<ReturnType<typeof testKeys>>;

  beforeAll(async () => {
    keys = await testKeys();
  });

  const strategy = () =>
    accessAuthStrategy<TestUser>({
      audience: AUD,
      getKey: keys.getKey,
      teamDomain: TEAM_DOMAIN,
    });

  const assertion = async (claims = {}) =>
    new Headers({
      "Cf-Access-Jwt-Assertion": await signToken(keys.privateKey, claims),
    });

  it("resolves the user whose email matches the Access login", async () => {
    const payload = fakePayload([{ email: "editor@example.com", id: 7 }]);
    const headers = await assertion({ email: "Editor@Example.com" });

    await expect(
      strategy().authenticate({ headers, payload })
    ).resolves.toStrictEqual({
      user: {
        _strategy: "cloudflare-access",
        collection: "users",
        email: "editor@example.com",
        id: 7,
      },
    });
    expect(payload.find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "users",
        overrideAccess: true,
        where: { email: { equals: "editor@example.com" } },
      })
    );
  });

  it("returns no user without a token, so other strategies still run", async () => {
    const payload = fakePayload([{ email: "editor@example.com", id: 1 }]);

    await expect(
      strategy().authenticate({ headers: new Headers(), payload })
    ).resolves.toStrictEqual({ user: null });
    expect(payload.find).not.toHaveBeenCalled();
  });

  it("returns no user for a service token", async () => {
    const payload = fakePayload([{ email: "editor@example.com", id: 1 }]);

    const headers = await assertion({
      common_name: "client-id.access",
      email: undefined,
    });

    await expect(
      strategy().authenticate({ headers, payload })
    ).resolves.toStrictEqual({ user: null });
  });

  it("returns no user when no account matches", async () => {
    const headers = await assertion();

    await expect(
      strategy().authenticate({ headers, payload: fakePayload([]) })
    ).resolves.toStrictEqual({ user: null });
  });
});
