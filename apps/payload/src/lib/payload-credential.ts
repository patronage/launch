import { parseCookies } from "payload";

// Whether a request should be left to Payload's own strategies instead of the
// Access strategies in collections/users.ts.
//
// Payload 4 (checked at 4.0.0-beta.8) runs custom strategies before its own `local-jwt`
// strategy, so the Access strategy has to step aside for an admin who is
// already signed in to Payload: a user signed in through Access has no session
// id, and Payload would refuse to refresh that admin's session.
//
// It steps aside only for a credential that works. An Authorization header is
// left to Payload as it is. A `payload-token` cookie counts only when
// `sessionIsValid` confirms it: a stale cookie (an expired session, or one
// left over from creating the first user) would otherwise leave a signed-in
// Access user with no Payload user at all.
export const shouldDeferToPayload = async (
  headers: Headers,
  cookiePrefix: string,
  sessionIsValid: () => Promise<boolean>
): Promise<boolean> => {
  if (headers.has("authorization")) {
    return true;
  }

  if (!parseCookies(headers).has(`${cookiePrefix}-token`)) {
    return false;
  }

  return await sessionIsValid();
};
