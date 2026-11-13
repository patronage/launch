import { env } from "cloudflare:workers";

import { accessSignInEnabled } from "@/lib/access-logout";

import { LogoutMenuItem } from "./logout-menu-item";

/**
 * The user menu's "Log out" item. With Access sign-in on, logging out also
 * ends the Access session; without it (local development), it is Payload's
 * own logout.
 */
export const LogoutButton = () => (
  <LogoutMenuItem endAccessSession={accessSignInEnabled(env)} />
);
