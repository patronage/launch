import { headers } from "next/headers";
import { getPayload } from "payload";

import { firstUser, isLocalRequest, LOCAL_LOGIN_PATH } from "@/lib/local-login";
import { getPayloadConfig } from "@/lib/payload-config";

/**
 * Above the admin's login form on a developer's machine: a button that signs
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
    <form
      action={LOCAL_LOGIN_PATH}
      method="post"
      style={{ marginBottom: "1.5rem" }}
    >
      <button
        className="btn btn--style-secondary btn--size-medium"
        type="submit"
      >
        Continue as {user.email}
      </button>
    </form>
  );
};
