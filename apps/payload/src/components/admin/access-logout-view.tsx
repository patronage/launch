import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import type { AdminViewServerProps } from "payload";
import { formatAdminURL } from "payload/shared";

import { accessSignInEnabled } from "@/lib/access-logout";

import { AccessLogoutClient } from "./access-logout-client";

/**
 * /admin/access-logout: ends the Payload session, then the Access session
 * (see lib/access-logout.ts). Without Access sign-in it hands over to
 * Payload's own logout view.
 */
export const AccessLogoutView = ({ initPageResult }: AdminViewServerProps) => {
  if (!accessSignInEnabled(env)) {
    const { config } = initPageResult.req.payload;

    redirect(
      formatAdminURL({
        adminRoute: config.routes.admin,
        path: config.admin.routes.logout,
      })
    );
  }

  return <AccessLogoutClient />;
};
