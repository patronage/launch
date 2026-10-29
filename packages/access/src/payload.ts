import { ACCESS_ASSERTION_HEADER, verifyAccessJwt } from "./jwt.ts";
import type { AccessJwtConfig, AccessVerifyResult } from "./jwt.ts";

/** The fields the strategy needs from a user document; the rest pass through. */
export interface PayloadUserDoc {
  id: number | string;
}

/**
 * The slice of Payload's Local API the strategy uses. Declared structurally so
 * this package does not depend on Payload; a real `Payload` instance fits.
 */
export interface PayloadUserLookup<TUser extends PayloadUserDoc> {
  find: (args: {
    collection: string;
    where: { email: { equals: string } };
    limit: number;
    depth: number;
    overrideAccess: boolean;
  }) => Promise<{ docs: TUser[] }>;
}

export interface AuthenticateArgs<TUser extends PayloadUserDoc> {
  headers: Headers;
  payload: PayloadUserLookup<TUser>;
}

export interface AuthenticateResult<TUser extends PayloadUserDoc> {
  user: (TUser & { collection: string; _strategy: string }) | null;
}

export interface AccessAuthStrategyOptions extends AccessJwtConfig {
  /** Auth-enabled collection whose `email` field matches the Access login. */
  collection?: string;
  /** Request header holding the JWT. Defaults to the one Access sets. */
  header?: string;
  /** Called on every verification outcome, for logging. Never sees the token. */
  onResult?: (result: AccessVerifyResult) => void;
}

export const ACCESS_STRATEGY_NAME = "cloudflare-access";

/**
 * A Payload custom auth strategy (`auth.strategies` on a collection) that
 * authenticates a request as the user whose email matches a verified
 * Cloudflare Access JWT. Requests without a token, with an invalid token, or
 * from a service token resolve to no user, so Payload falls through to its
 * other strategies and the collection's access control decides.
 */
export const accessAuthStrategy = <TUser extends PayloadUserDoc>(
  options: AccessAuthStrategyOptions
) => {
  const collection = options.collection ?? "users";
  const header = options.header ?? ACCESS_ASSERTION_HEADER;

  const authenticate = async ({
    headers,
    payload,
  }: AuthenticateArgs<TUser>): Promise<AuthenticateResult<TUser>> => {
    const result = await verifyAccessJwt(headers.get(header), options);
    options.onResult?.(result);

    if (!result.ok || result.identity.kind !== "user") {
      return { user: null };
    }

    const { docs } = await payload.find({
      collection,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { email: { equals: result.identity.email.toLowerCase() } },
    });

    const [user] = docs;

    return user
      ? { user: { ...user, _strategy: ACCESS_STRATEGY_NAME, collection } }
      : { user: null };
  };

  return { authenticate, name: ACCESS_STRATEGY_NAME };
};
