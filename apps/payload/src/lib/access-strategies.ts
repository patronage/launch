import {
  ACCESS_STRATEGY_NAME,
  accessAuthStrategy,
  accessGatewayAuthStrategy,
} from "@patronage/access/payload";
import { JWTAuthentication } from "payload";
import type { AuthStrategy } from "payload";

import type { User } from "../payload-types";
import { accessOptedOut } from "./access-opt-out";
import { shouldDeferToPayload } from "./payload-credential";

type AccessStrategy = ReturnType<typeof accessAuthStrategy<User>>;

/** The Worker settings that decide which Access strategies are on. */
export interface AccessStrategySettings {
  ACCESS_AUD?: string;
  ACCESS_GATEWAY_AUD?: string;
  ACCESS_GATEWAY_PROOF_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

// Whether Payload's own credential signs a request in, kept per request.
const payloadSessionChecks = new WeakMap<Headers, Promise<boolean>>();

// @patronage/access types the Local API loosely, so each strategy is wrapped
// to pin the lookup to the users collection, and to step aside for a request
// that Payload's own credential already signs in (see payload-credential.ts).
const asPayloadStrategy = (strategy: AccessStrategy): AuthStrategy => ({
  authenticate: async (args) => {
    const { headers, payload } = args;

    // Both Access strategies see the same request, so check it once.
    const sessionIsValid = (): Promise<boolean> => {
      const cached = payloadSessionChecks.get(headers);

      if (cached) {
        return cached;
      }

      const checked = (async () => {
        const session = await JWTAuthentication(args);

        return Boolean(session.user);
      })();

      payloadSessionChecks.set(headers, checked);

      return checked;
    };

    // An editor who logged out stays logged out of the browser strategy until
    // they sign in again (see access-opt-out.ts). The gateway's calls never
    // carry the browser's cookies, so it is not affected.
    if (
      strategy.name === ACCESS_STRATEGY_NAME &&
      accessOptedOut(headers, payload.config.cookiePrefix)
    ) {
      return { user: null };
    }

    if (
      await shouldDeferToPayload(
        headers,
        payload.config.cookiePrefix,
        sessionIsValid
      )
    ) {
      return { user: null };
    }

    const { user } = await strategy.authenticate({
      headers,
      payload: {
        find: ({ depth, limit, overrideAccess, where }) =>
          payload.find({
            collection: "users",
            depth,
            limit,
            overrideAccess,
            where,
          }),
      },
    });

    return { user: user ? { ...user, collection: "users" } : null };
  },
  name: strategy.name,
});

// With Access configured, a request carrying a verified Access JWT is signed
// in as the user with the same email. This is how the MCP endpoint
// (/api/mcp) knows who is calling. Without it, only Payload's own login works.
//
// The MCP gateway calls on an editor's behalf with that editor's JWT for the
// gateway's own Access application, in `X-Access-User-Jwt`, and a proof
// signed with the secret the two Workers share. Over a Service binding the
// request never crosses Access, so the proof is what makes it trustworthy:
// the gateway strategy is on only when both ACCESS_GATEWAY_AUD and
// ACCESS_GATEWAY_PROOF_SECRET are set.
export const accessStrategies = (
  env: AccessStrategySettings
): AuthStrategy[] => {
  if (!env.ACCESS_TEAM_DOMAIN) {
    return [];
  }

  const strategies: AuthStrategy[] = [];

  if (env.ACCESS_AUD) {
    strategies.push(
      asPayloadStrategy(
        accessAuthStrategy<User>({
          audience: env.ACCESS_AUD,
          collection: "users",
          teamDomain: env.ACCESS_TEAM_DOMAIN,
        })
      )
    );
  }

  const gatewayProofSecret = env.ACCESS_GATEWAY_PROOF_SECRET;

  if (env.ACCESS_GATEWAY_AUD && gatewayProofSecret) {
    strategies.push(
      asPayloadStrategy(
        accessGatewayAuthStrategy<User>({
          audience: env.ACCESS_GATEWAY_AUD,
          collection: "users",
          gatewayProofSecret,
          teamDomain: env.ACCESS_TEAM_DOMAIN,
        })
      )
    );
  }

  return strategies;
};
