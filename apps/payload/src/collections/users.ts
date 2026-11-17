import { env } from "cloudflare:workers";
import type { CollectionConfig } from "payload";

import {
  accessOptOutCookie,
  accessSignInEnabled,
  isHttps,
} from "../lib/access-opt-out";
import { accessSessionExp, parseAccessStrategy } from "../lib/access-session";
import { accessStrategies } from "../lib/access-strategies";
import { guardFirstUser } from "../lib/first-user-guard";

export const Users: CollectionConfig = {
  admin: {
    useAsTitle: "email",
  },
  // Cloudflare Access sign-in, for editors and for the MCP gateway (see
  // lib/access-strategies.ts).
  auth: { strategies: accessStrategies(env) },
  fields: [
    // Email added by default
    // Add more fields as needed
  ],
  hooks: {
    // Logging out leaves the Access session alone, so the Access strategy
    // would sign the editor straight back in. The opt-out cookie stops that
    // until they sign in again (see lib/access-opt-out.ts).
    afterLogout: [
      ({ req }) => {
        if (!accessSignInEnabled(env)) {
          return;
        }

        req.responseHeaders ??= new Headers();
        req.responseHeaders.append(
          "Set-Cookie",
          accessOptOutCookie({
            cookiePrefix: req.payload.config.cookiePrefix,
            secure: isHttps(req.url),
          })
        );
      },
    ],
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
