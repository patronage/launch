"use client";

import {
  LogOutIcon,
  PopupList,
  useAuth,
  useConfig,
  useTranslation,
} from "@payloadcms/ui";
import { formatAdminURL } from "payload/shared";

import { logOutOfPayloadAndAccess } from "@/lib/access-logout";

interface LogoutMenuItemProps {
  /** Also end the Access session (see lib/access-logout.ts). */
  endAccessSession: boolean;
}

/**
 * The "Log out" item in the admin's user menu. Without Access it is Payload's
 * own: a link to the logout view. With Access it ends the Payload session and
 * then the Access session.
 */
export const LogoutMenuItem = ({ endAccessSession }: LogoutMenuItemProps) => {
  const { logOut } = useAuth();
  const { config } = useConfig();
  const { t } = useTranslation();

  const label = t("authentication:logOut");

  if (!endAccessSession) {
    return (
      <PopupList.Button
        href={formatAdminURL({
          adminRoute: config.routes.admin,
          path: config.admin.routes.logout,
        })}
        icon={<LogOutIcon />}
      >
        {label}
      </PopupList.Button>
    );
  }

  return (
    <PopupList.Button
      icon={<LogOutIcon />}
      onClick={() =>
        logOutOfPayloadAndAccess(logOut, (url) => window.location.assign(url))
      }
    >
      {label}
    </PopupList.Button>
  );
};
