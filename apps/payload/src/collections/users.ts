import {
  accessAuthStrategy,
  accessGatewayAuthStrategy,
} from "@patronage/access/payload";
import { env } from "cloudflare:workers";
import { JWTAuthentication } from "payload";
import type { AuthStrategy, CollectionConfig } from "payload";

import { accessSessionExp, parseAccessStrategy } from "../lib/access-session";
import { guardFirstUser } from "../lib/first-user-guard";
import { shouldDeferToPayload } from "../lib/payload-credential";
import type { User } from "../payload-types";

type AccessStrategy = ReturnType<typeof accessAuthStrategy<User>>;

// Whether Payload's own credential signs a request in, kept per request.
const payloadSessionChecks = new WeakMap<Headers, Promise<boolean>>();

// @patronage/access types the Local API loosely, so each strategy is wrapped
// to pin the lookup to the users collection, and to step aside for a request
// that Payload's own credential already signs in (see lib/payload-credential.ts).
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
    // Report the Access session's expiry, not a leftover payload-token's
    // (see lib/access-session.ts).
    me: [
      ({ args, user }) => {
        const strategy = parseAccessStrategy(user?._strategy);

        if (!strategy) {
          return;
        }

        const exp = accessSessionExp(args.req.headers, strategy);

        return exp === undefined ? undefined : { exp, user };
      },
    ],
  },
  slug: "users",
  versions: false,
};
