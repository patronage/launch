import { draftMode, headers as getHeaders } from "next/headers";
import { getPayload } from "payload";
import { cache } from "react";

import { getPayloadConfig } from "./payload-config";

// Front-end reads go through the Local API as the requesting user (or anonymous).
// Payload 4 already defaults the Local API to `overrideAccess: false`; the
// front end still passes it with the user on every call, so access control
// does not depend on that default. `draft` is true when a logged-in editor
// opened the page from the admin's preview (app/(frontend)/next/preview).
//
// React's cache() keeps one result per request, so the layout, the page and
// their generateMetadata share one auth check instead of each running it.
export const getFrontendPayload = cache(async () => {
  const payload = await getPayload({ config: getPayloadConfig() });
  const { user } = await payload.auth({ headers: await getHeaders() });
  const { isEnabled } = await draftMode();
  const draft = Boolean(user) && isEnabled;

  return { draft, payload, user };
});

/** The site settings global, read once per request for the layout and its metadata. */
export const getSiteSettings = cache(async () => {
  const { payload, user } = await getFrontendPayload();

  return payload.findGlobal({
    overrideAccess: false,
    slug: "site-settings",
    user,
  });
});
