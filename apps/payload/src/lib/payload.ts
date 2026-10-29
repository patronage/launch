import config from "@payload-config";
import { headers as getHeaders } from "next/headers";
import { getPayload } from "payload";

// Front-end reads go through the Local API as the requesting user (or anonymous).
// Payload 4 already defaults the Local API to `overrideAccess: false`; the
// front end still passes it with the user on every call, so access control
// does not depend on that default.
export const getFrontendPayload = async () => {
  const payload = await getPayload({ config });
  const { user } = await payload.auth({ headers: await getHeaders() });

  return { payload, user };
};
