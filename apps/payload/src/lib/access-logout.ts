// Logging out of the admin when Cloudflare Access signs editors in.
//
// Payload's own logout clears its `payload-token` cookie, but the browser
// still holds the Access session, so the next request signs the editor
// straight back in through the Access strategy (collections/users.ts). Ending
// the Access session as well sends the next /admin visit to the Access login.
//
// Cloudflare ends the session at /cdn-cgi/access/logout on any hostname that
// an Access application covers. It ends it for every Access application the
// editor is signed in to, not only this one.

export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

interface AccessSettings {
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

/** Whether the Access strategy signs editors in: both settings are set. */
export const accessSignInEnabled = ({
  ACCESS_AUD,
  ACCESS_TEAM_DOMAIN,
}: AccessSettings): boolean => Boolean(ACCESS_TEAM_DOMAIN && ACCESS_AUD);

/**
 * End the Payload session, then the Access session. The Access logout runs
 * even if Payload's fails: an editor signed in only through Access has no
 * Payload session to end, and leaving Access signed in would sign them back in.
 */
export const logOutOfPayloadAndAccess = async (
  logOut: () => Promise<boolean>,
  navigate: (url: string) => void
): Promise<void> => {
  try {
    await logOut();
  } catch {
    // Ending the Access session below is what keeps the editor signed out.
  }

  navigate(ACCESS_LOGOUT_PATH);
};
