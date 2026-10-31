import { accessAuthStrategy } from "@patronage/access/payload";
import { env } from "cloudflare:workers";
import type { AuthStrategy, CollectionConfig } from "payload";

import type { User } from "../payload-types";

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
