import { headers } from "next/headers";
import { getPayload } from "payload";

import { firstUser, isLocalRequest, LOCAL_LOGIN_PATH } from "@/lib/local-login";
import { getPayloadConfig } from "@/lib/payload-config";

/**
 * Above the admin's login form on a developer's machine: a link that signs
 * in as the first admin user. Through a tunnel or in production it draws
 * nothing.
 */
export const LocalLoginLink = async () => {
  if (!isLocalRequest(await headers())) {
    return null;
  }

  const user = await firstUser(
    await getPayload({ config: getPayloadConfig() })
  );

  if (!user) {
    return null;
  }

  return (
    <p style={{ marginBottom: "1.5rem" }}>
      <a
        className="btn btn--style-secondary btn--size-medium"
        href={LOCAL_LOGIN_PATH}
      >
        Continue as {user.email}
      </a>
    </p>
  );
};
