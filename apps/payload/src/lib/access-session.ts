import {
  ACCESS_ASSERTION_HEADER,
  FORWARDED_JWT_HEADER,
} from "@patronage/access";
import {
  ACCESS_GATEWAY_STRATEGY_NAME,
  ACCESS_STRATEGY_NAME,
} from "@patronage/access/payload";
import { decodeJwt } from "jose";
import { z } from "zod";

const accessStrategyName = z.enum([
  ACCESS_STRATEGY_NAME,
  ACCESS_GATEWAY_STRATEGY_NAME,
]);

export type AccessStrategyName = z.infer<typeof accessStrategyName>;

// The header each Access strategy read its JWT from.
const JWT_HEADER_BY_STRATEGY: Record<AccessStrategyName, string> = {
  [ACCESS_GATEWAY_STRATEGY_NAME]: FORWARDED_JWT_HEADER,
  [ACCESS_STRATEGY_NAME]: ACCESS_ASSERTION_HEADER,
};

const expClaim = z.object({ exp: z.number() });

/** The Access strategy that signed a user in, or undefined for any other. */
export const parseAccessStrategy = (
  strategy: string | undefined
): AccessStrategyName | undefined =>
  accessStrategyName.safeParse(strategy).data;

// When an Access strategy signed the request in, Payload's `me` operation
// would still decode any `payload-token` cookie the browser sends and report
// that cookie's `exp`. A stale cookie's `exp` is in the past, so the admin
// would treat a working Access session as expired; a malformed one makes the
// decode throw. Report the Access JWT's expiry instead. The strategy has
// already verified that JWT, so decoding it here is enough.
export const accessSessionExp = (
  headers: Headers,
  strategy: AccessStrategyName
): number | undefined => {
  const token = headers.get(JWT_HEADER_BY_STRATEGY[strategy]);

  if (!token) {
    return undefined;
  }

  try {
    return expClaim.safeParse(decodeJwt(token)).data?.exp;
  } catch {
    return undefined;
  }
};
