import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { APIError } from "payload";
import type {
  CollectionBeforeOperationHook,
  Payload,
  PayloadRequest,
  SanitizedCollectionConfig,
} from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { firstUserAllowed, guardFirstUser } from "./first-user-guard";

const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
const AUD = "payload-aud";
const ACCESS = { audience: AUD, teamDomain: TEAM_DOMAIN };
const EMAIL = "editor@example.com";

// A request from outside this machine, as Cloudflare's edge delivers it.
const REMOTE = {
  "cf-connecting-ip": "203.0.113.7",
  "cf-ray": "8f0000000000-IAD",
  host: "cms.example.com",
};

const LOCAL = { "cf-connecting-ip": "127.0.0.1", host: "localhost:5173" };

// One key pair for the file: @patronage/access caches the remote key set per
// team domain, so the certs it fetches first are the ones every test signs with.
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "k" };

// Serves the key pair as the team's Access certs for the tests in a block.
const serveAccessCerts = () => {
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
};

const accessToken = (claims: JWTPayload = {}) =>
  new SignJWT({ email: EMAIL, sub: "access-subject", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(TEAM_DOMAIN)
    .setAudience(AUD)
    .sign(privateKey);

const remoteWithToken = async (claims: JWTPayload = {}) =>
  new Headers({
    ...REMOTE,
    "cf-access-jwt-assertion": await accessToken(claims),
  });

describe(firstUserAllowed, () => {
  serveAccessCerts();

  it("allows a request made on this machine without Access", async () => {
    await expect(
      firstUserAllowed(new Headers(LOCAL), EMAIL, {})
    ).resolves.toBeTruthy();
  });

  it("allows an Access login for the same email", async () => {
    await expect(
      firstUserAllowed(await remoteWithToken(), EMAIL, ACCESS)
    ).resolves.toBeTruthy();
  });

  it("compares the email without case or surrounding space", async () => {
    await expect(
      firstUserAllowed(
        await remoteWithToken({ email: "Editor@Example.com" }),
        "  EDITOR@example.com ",
        ACCESS
      )
    ).resolves.toBeTruthy();
  });

  it("refuses an Access login for a different email", async () => {
    await expect(
      firstUserAllowed(await remoteWithToken(), "someone@example.com", ACCESS)
    ).resolves.toBeFalsy();
  });

  it("refuses a service token, which has no email", async () => {
    const headers = await remoteWithToken({
      common_name: "client-id.access",
      email: undefined,
      sub: "",
    });

    await expect(firstUserAllowed(headers, EMAIL, ACCESS)).resolves.toBeFalsy();
  });

  it("refuses a token for another Access application", async () => {
    await expect(
      firstUserAllowed(await remoteWithToken(), EMAIL, {
        ...ACCESS,
        audience: "another-aud",
      })
    ).resolves.toBeFalsy();
  });

  it("refuses a remote request with no Access token", async () => {
    await expect(
      firstUserAllowed(new Headers(REMOTE), EMAIL, ACCESS)
    ).resolves.toBeFalsy();
  });

  it.each([
    ["no team domain", { audience: AUD }],
    ["no audience", { teamDomain: TEAM_DOMAIN }],
    ["no Access settings", {}],
  ])("refuses a remote request when Access has %s", async (_name, access) => {
    await expect(
      firstUserAllowed(await remoteWithToken(), EMAIL, access)
    ).resolves.toBeFalsy();
  });

  it("refuses a remote request with no email to compare", async () => {
    await expect(
      firstUserAllowed(await remoteWithToken(), undefined, ACCESS)
    ).resolves.toBeFalsy();
  });
});

type HookArgs = Parameters<CollectionBeforeOperationHook>[0];

type SignedInUser = NonNullable<PayloadRequest["user"]>;

// A Payload value faked with only the members the guard reads. The hook's
// arguments are typed per operation and these tests vary the operation, so
// the fake takes any object rather than a partial of one member of that union.
// oxlint-disable-next-line anti-slop/no-object-parameters -- see above.
const fake = <T>(members: object): T =>
  // SAFETY: Any member the guard does not read is missing at runtime.
  members as T;

const hookCall = (options: {
  existingUsers?: number;
  headers?: Headers;
  operation?: HookArgs["operation"];
  signedIn?: boolean;
}) => {
  const count = vi.fn<() => Promise<{ totalDocs: number }>>(() =>
    Promise.resolve({ totalDocs: options.existingUsers ?? 0 })
  );

  const args = { data: { email: EMAIL, password: "a-password" } };

  const hookArgs = fake<HookArgs>({
    args,
    collection: fake<SanitizedCollectionConfig>({ slug: "users" }),
    context: {},
    operation: options.operation ?? "create",
    req: fake<PayloadRequest>({
      headers: options.headers ?? new Headers(REMOTE),
      payload: fake<Payload>({ count }),
      user: options.signedIn
        ? fake<SignedInUser>({ email: EMAIL, id: 1 })
        : null,
    }),
  });

  return { args, count, hookArgs };
};

const guard = guardFirstUser(() => ACCESS);

describe(guardFirstUser, () => {
  serveAccessCerts();

  it("refuses a remote first user with no Access login", async () => {
    const { hookArgs } = hookCall({});

    const refusal = await Promise.resolve(guard(hookArgs)).catch(
      (error: Error) => error
    );

    expect(refusal).toBeInstanceOf(APIError);
    expect(refusal).toMatchObject({ status: 403 });
  });

  it("lets the first user through from this machine", async () => {
    const { args, hookArgs } = hookCall({ headers: new Headers(LOCAL) });

    await expect(guard(hookArgs)).resolves.toBe(args);
  });

  it("lets the first user through with an Access login for the same email", async () => {
    const { args, hookArgs } = hookCall({ headers: await remoteWithToken() });

    await expect(guard(hookArgs)).resolves.toBe(args);
  });

  it("does not guard a create once a user exists", async () => {
    const { args, hookArgs } = hookCall({ existingUsers: 1 });

    await expect(guard(hookArgs)).resolves.toBe(args);
  });

  it("does not guard a create by a signed-in user, or count users for it", async () => {
    const { args, count, hookArgs } = hookCall({ signedIn: true });

    await expect(guard(hookArgs)).resolves.toBe(args);
    expect(count).not.toHaveBeenCalled();
  });

  it.each(["read", "update", "delete", "login"] as const)(
    "does not guard a %s",
    async (operation) => {
      const { args, count, hookArgs } = hookCall({ operation });

      await expect(guard(hookArgs)).resolves.toBe(args);
      expect(count).not.toHaveBeenCalled();
    }
  );

  it("counts users with access control off, so an anonymous count is not zero by accident", async () => {
    const { count, hookArgs } = hookCall({ existingUsers: 1 });

    await guard(hookArgs);

    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "users", overrideAccess: true })
    );
  });
});
