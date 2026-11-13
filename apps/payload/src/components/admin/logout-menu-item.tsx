"use client";

import {
  LogOutIcon,
  PopupList,
  useConfig,
  useTranslation,
} from "@payloadcms/ui";
import { formatAdminURL } from "payload/shared";

import { ACCESS_LOGOUT_VIEW_PATH } from "@/lib/access-logout";

interface LogoutMenuItemProps {
  /** Also end the Access session (see lib/access-logout.ts). */
  endAccessSession: boolean;
}

/**
 * The "Log out" item in the admin's user menu: a link, like Payload's own, so
 * the leave-without-saving prompt still guards unsaved edits. Without Access
 * it goes to Payload's logout view; with Access, to the view that also ends
 * the Access session.
 */
export const LogoutMenuItem = ({ endAccessSession }: LogoutMenuItemProps) => {
  const { config } = useConfig();
  const { t } = useTranslation();

  return (
    <PopupList.Button
      href={formatAdminURL({
        adminRoute: config.routes.admin,
        path: endAccessSession
          ? ACCESS_LOGOUT_VIEW_PATH
          : config.admin.routes.logout,
      })}
      icon={<LogOutIcon />}
    >
      {t("authentication:logOut")}
    </PopupList.Button>
  );
};
