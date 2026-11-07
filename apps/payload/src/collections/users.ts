import {
  accessAuthStrategy,
  accessGatewayAuthStrategy,
} from "@patronage/access/payload";
import { env } from "cloudflare:workers";
import { parseCookies } from "payload";
import type { AuthStrategy, CollectionConfig } from "payload";

import { guardFirstUser } from "../lib/first-user-guard";
import type { User } from "../payload-types";

// A request that already carries Payload's own credential (the admin's
// session cookie or an Authorization header) is left to Payload's strategies.
// Payload 4.0.0-beta.6 runs those first anyway; this keeps it that way if the
// order changes, because a user signed in through Access has no session id
// and Payload would refuse to refresh the admin's session.
const hasPayloadCredential = (headers: Headers, cookiePrefix: string) =>
  headers.has("authorization") ||
  parseCookies(headers).has(`${cookiePrefix}-token`);

type AccessStrategy = ReturnType<typeof accessAuthStrategy<User>>;

// @patronage/access types the Local API loosely, so each strategy is wrapped
// to pin the lookup to the users collection, and to step aside for a request
// that already carries Payload's own credential.
const asPayloadStrategy = (strategy: AccessStrategy): AuthStrategy => ({
  authenticate: async ({ headers, payload }) => {
    if (hasPayloadCredential(headers, payload.config.cookiePrefix)) {
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
const accessStrategies = (): AuthStrategy[] => {
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

export const Users: CollectionConfig = {
  admin: {
    useAsTitle: "email",
  },
  auth: { strategies: accessStrategies() },
  fields: [
    // Email added by default
    // Add more fields as needed
  ],
  hooks: {
    // The first user comes from localhost or through Access, never from
    // whoever reaches a fresh deploy first.
    beforeOperation: [
      guardFirstUser(() => ({
        audience: env.ACCESS_AUD,
        teamDomain: env.ACCESS_TEAM_DOMAIN,
      })),
    ],
  },
  slug: "users",
  versions: false,
};
