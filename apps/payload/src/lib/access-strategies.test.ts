import {
  ACCESS_ASSERTION_HEADER,
  computeGatewayProof,
  FORWARDED_JWT_HEADER,
  GATEWAY_PROOF_HEADER,
} from "@patronage/access";
import {
  ACCESS_GATEWAY_STRATEGY_NAME,
  ACCESS_STRATEGY_NAME,
} from "@patronage/access/payload";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { parseCookies } from "payload";
import type { AuthStrategy, AuthStrategyFunctionArgs } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accessStrategies } from "./access-strategies";
import type { AccessStrategySettings } from "./access-strategies";

// Payload's own JWT check needs a booted Payload. Here a `payload-token`
// cookie is a working session when its value is "current", and stale
// otherwise, which is all the Access strategies ask of it.
// oxlint-disable-next-line anti-slop/no-module-mocking -- Payload's JWT check needs a booted Payload.
vi.mock(import("payload"), async (importOriginal) => {
  const actual = await importOriginal();

  const replaced = {
    ...actual,
    JWTAuthentication: ({ headers }: AuthStrategyFunctionArgs) =>
      Promise.resolve({
        user:
          parseCookies(headers).get("payload-token") === "current"
            ? { collection: "users", email: EMAIL, id: 1 }
            : null,
      }),
  };

  // SAFETY: only JWTAuthentication is replaced, with the same signature.
  return replaced as typeof actual;
});

const TEAM_DOMAIN = "https://strategies.cloudflareaccess.com";
const AUD = "admin-aud";
const GATEWAY_AUD = "gateway-aud";
const SECRET = "shared-proof-secret";
const EMAIL = "editor@example.com";

const ALL: Required<AccessStrategySettings> = {
  ACCESS_AUD: AUD,
  ACCESS_GATEWAY_AUD: GATEWAY_AUD,
  ACCESS_GATEWAY_PROOF_SECRET: SECRET,
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
};

// SAFETY: `ALL` has exactly the settings' keys.
const SETTING_NAMES = Object.keys(ALL) as (keyof AccessStrategySettings)[];

// Every combination of the four settings being set or left out.
const combinations: AccessStrategySettings[] = Array.from(
  { length: 2 ** SETTING_NAMES.length },
  (_, mask) =>
    Object.fromEntries(
      SETTING_NAMES.flatMap((name, bit) =>
        // oxlint-disable-next-line no-bitwise
        mask & (1 << bit) ? [[name, ALL[name]]] : []
      )
    )
);

// The strategies each combination should turn on, by name.
const expectedNames = (env: AccessStrategySettings): string[] => {
  if (!env.ACCESS_TEAM_DOMAIN) {
    return [];
  }

  return [
    ...(env.ACCESS_AUD ? [ACCESS_STRATEGY_NAME] : []),
    ...(env.ACCESS_GATEWAY_AUD && env.ACCESS_GATEWAY_PROOF_SECRET
      ? [ACCESS_GATEWAY_STRATEGY_NAME]
      : []),
  ];
};

const describeSettings = (env: AccessStrategySettings) =>
  SETTING_NAMES.filter((name) => env[name]).join(" + ") || "nothing";

describe(accessStrategies, () => {
  it.each(combinations.map((env) => [describeSettings(env), env] as const))(
    "turns on the right strategies with %s set",
    (_, env) => {
      const strategies = accessStrategies(env);

      expect(strategies.map(({ name }) => name)).toStrictEqual(
        expectedNames(env)
      );
    }
  );

  it("leaves the gateway strategy off without the proof secret, even with its audience", () => {
    const { ACCESS_GATEWAY_PROOF_SECRET: _, ...withoutSecret } = ALL;

    expect(
      accessStrategies(withoutSecret).map(({ name }) => name)
    ).toStrictEqual([ACCESS_STRATEGY_NAME]);
  });

  it("treats an empty proof secret as unset", () => {
    expect(
      accessStrategies({ ...ALL, ACCESS_GATEWAY_PROOF_SECRET: "" }).map(
        ({ name }) => name
      )
    ).toStrictEqual([ACCESS_STRATEGY_NAME]);
  });
});

// One key pair for the file: @patronage/access caches the remote key set per
// team domain, so the certs it fetches first are the ones every test signs with.
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "k" };

const accessToken = (audience: string) =>
  new SignJWT({ email: EMAIL, sub: "access-subject" })
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(TEAM_DOMAIN)
    .setAudience(audience)
    .sign(privateKey);

const EDITOR = { email: EMAIL, id: 7 };

// The parts of Payload the strategies use: its cookie prefix and a users
// lookup that finds the editor by email.
const fakePayload = {
  config: { cookiePrefix: "payload" },
  find: () => Promise.resolve({ docs: [EDITOR] }),
};

const authenticate = (strategy: AuthStrategy, headers: Headers) =>
  strategy.authenticate({
    headers,
    // SAFETY: the strategies read only `config.cookiePrefix` and `find`.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial Payload.
    payload: fakePayload as unknown as AuthStrategyFunctionArgs["payload"],
  });

// A browser request through Access, plus any extra headers.
const browserRequest = async (extra: Record<string, string> = {}) =>
  new Headers({ [ACCESS_ASSERTION_HEADER]: await accessToken(AUD), ...extra });

// A call from the MCP gateway with the editor's JWT and a valid proof.
const gatewayRequest = async (extra: Record<string, string> = {}) => {
  const jwt = await accessToken(GATEWAY_AUD);

  return new Headers({
    [FORWARDED_JWT_HEADER]: jwt,
    [GATEWAY_PROOF_HEADER]: await computeGatewayProof(SECRET, jwt),
    ...extra,
  });
};

const strategyNamed = (name: string): AuthStrategy => {
  const strategy = accessStrategies(ALL).find(
    (candidate) => candidate.name === name
  );

  if (!strategy) {
    throw new Error(`no ${name} strategy`);
  }

  return strategy;
};

describe("the Access strategies on a request", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
      String(input) === `${TEAM_DOMAIN}/cdn-cgi/access/certs`
        ? Promise.resolve(Response.json({ keys: [jwk] }))
        : Promise.reject(new Error(`unexpected fetch to ${String(input)}`))
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const cases = [
    { name: ACCESS_STRATEGY_NAME, request: browserRequest },
    { name: ACCESS_GATEWAY_STRATEGY_NAME, request: gatewayRequest },
  ];

  describe.each(cases)("$name", ({ name, request }) => {
    it("signs in the editor whose email matches the Access login", async () => {
      await expect(
        authenticate(strategyNamed(name), await request())
      ).resolves.toStrictEqual({
        user: { ...EDITOR, _strategy: name, collection: "users" },
      });
    });

    it("steps aside for a request with a working Payload session cookie", async () => {
      await expect(
        authenticate(
          strategyNamed(name),
          await request({ cookie: "payload-token=current" })
        )
      ).resolves.toStrictEqual({ user: null });
    });

    it("steps aside for a request with an Authorization header", async () => {
      await expect(
        authenticate(
          strategyNamed(name),
          await request({ authorization: "users API-Key abc" })
        )
      ).resolves.toStrictEqual({ user: null });
    });

    it("still signs in through Access when the Payload cookie is stale", async () => {
      await expect(
        authenticate(
          strategyNamed(name),
          await request({ cookie: "payload-token=expired" })
        )
      ).resolves.toStrictEqual({
        user: { ...EDITOR, _strategy: name, collection: "users" },
      });
    });
  });

  it("keeps an editor who logged out signed out of the browser strategy", async () => {
    await expect(
      authenticate(
        strategyNamed(ACCESS_STRATEGY_NAME),
        await browserRequest({ cookie: "payload-access-off=1" })
      )
    ).resolves.toStrictEqual({ user: null });
  });

  it("does not let the logout cookie stop the gateway", async () => {
    await expect(
      authenticate(
        strategyNamed(ACCESS_GATEWAY_STRATEGY_NAME),
        await gatewayRequest({ cookie: "payload-access-off=1" })
      )
    ).resolves.toStrictEqual({
      user: {
        ...EDITOR,
        _strategy: ACCESS_GATEWAY_STRATEGY_NAME,
        collection: "users",
      },
    });
  });
});
