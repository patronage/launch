import { accessAuthStrategy } from "@patronage/access/payload";
import { env } from "cloudflare:workers";
import { parseCookies } from "payload";
import type { AuthStrategy, CollectionConfig } from "payload";

import type { User } from "../payload-types";

// A request that already carries Payload's own credential (the admin's
// session cookie or an Authorization header) is left to Payload's strategies.
// Payload 4.0.0-beta.6 runs those first anyway; this keeps it that way if the
// order changes, because a user signed in through Access has no session id
// and Payload would refuse to refresh the admin's session.
const hasPayloadCredential = (headers: Headers, cookiePrefix: string) =>
  headers.has("authorization") ||
  parseCookies(headers).has(`${cookiePrefix}-token`);

// With Access configured, a request carrying a verified Access JWT is signed
// in as the user with the same email. This is how the MCP endpoint
// (/api/mcp) knows who is calling. Without it, only Payload's own login works.
const accessStrategies = (): AuthStrategy[] => {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return [];
  }

  const strategy = accessAuthStrategy<User>({
    audience: env.ACCESS_AUD,
    collection: "users",
    teamDomain: env.ACCESS_TEAM_DOMAIN,
  });

  return [
    {
      // @patronage/access types the Local API loosely, so pin the lookup to
      // the users collection here.
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
    },
  ];
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
  slug: "users",
  versions: false,
};
