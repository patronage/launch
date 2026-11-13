import { env } from "cloudflare:workers";
import type { NextRequest } from "next/server";
import { getPayload } from "payload";

import {
  accessSignInEnabled,
  clearAccessOptOutCookie,
  isHttps,
} from "@/lib/access-opt-out";
import { getPayloadConfig } from "@/lib/payload-config";

/**
 * Ends a logout's opt-out and opens the admin, where the Access strategy signs
 * the editor in again (see lib/access-opt-out.ts). It signs nobody in itself:
 * /admin is behind Access, and the strategy checks the Access JWT. It takes a
 * POST from the admin's own login page, so another site cannot undo a logout.
 */
export const POST = async (request: NextRequest): Promise<Response> => {
  if (!accessSignInEnabled(env)) {
    return new Response("Not found.", { status: 404 });
  }

  const site = request.headers.get("sec-fetch-site");

  if (site !== null && site !== "same-origin") {
    return new Response("Sign in from the admin's login page.", {
      status: 403,
    });
  }

  const payload = await getPayload({ config: getPayloadConfig() });

  return new Response(null, {
    headers: {
      Location: payload.config.routes.admin,
      "Set-Cookie": clearAccessOptOutCookie({
        cookiePrefix: payload.config.cookiePrefix,
        secure: isHttps(request.url),
      }),
    },
    status: 303,
  });
};
