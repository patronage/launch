import type { NextRequest } from "next/server";
import {
  createPayloadRequest,
  getFieldsToSign,
  getPayload,
  jwtSign,
} from "payload";
import { addSessionToUser, generatePayloadCookie } from "payload/shared";

import { firstUser, isLocalRequest } from "@/lib/local-login";
import { getPayloadConfig } from "@/lib/payload-config";

/**
 * Signs in as the first admin user and opens the admin, with no password.
 * It issues the same session and token as Payload's own login. Answers only
 * on the developer's machine; anywhere else it is not found.
 */
export const GET = async (request: NextRequest): Promise<Response> => {
  if (!isLocalRequest(request.headers)) {
    return new Response("Not found.", { status: 404 });
  }

  const payload = await getPayload({ config: getPayloadConfig() });
  const req = await createPayloadRequest({ payload });
  const user = await firstUser(payload, req);

  if (!user) {
    return new Response("No admin user to sign in as.", { status: 404 });
  }

  const collectionConfig = payload.collections.users.config;

  const { sid } = await addSessionToUser({
    collectionConfig,
    payload,
    req,
    user,
  });

  const fieldsToSignArgs: Parameters<typeof getFieldsToSign>[0] = {
    collectionConfig,
    email: user.email,
    user,
  };

  if (sid) {
    fieldsToSignArgs.sid = sid;
  }

  const { token } = await jwtSign({
    fieldsToSign: getFieldsToSign(fieldsToSignArgs),
    secret: payload.secret,
    tokenExpiration: collectionConfig.auth.tokenExpiration,
  });

  const cookie = generatePayloadCookie({
    collectionAuthConfig: collectionConfig.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token,
  });

  return new Response(null, {
    headers: { Location: "/admin", "Set-Cookie": cookie },
    status: 303,
  });
};
