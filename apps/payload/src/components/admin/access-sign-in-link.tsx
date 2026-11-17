import { ACCESS_ASSERTION_HEADER } from "@patronage/access";
import { env } from "cloudflare:workers";
import { decodeJwt } from "jose";
import { headers } from "next/headers";
import { getPayload } from "payload";
import { z } from "zod";

import {
  ACCESS_SIGN_IN_PATH,
  accessOptedOut,
  accessSignInEnabled,
} from "@/lib/access-opt-out";
import { getPayloadConfig } from "@/lib/payload-config";

const emailClaim = z.object({ email: z.string() });

// For the button label only: the Access strategy verifies the JWT when it
// signs the editor in.
const accessEmail = (token: string | null): string | undefined => {
  if (!token) {
    return undefined;
  }

  try {
    return emailClaim.safeParse(decodeJwt(token)).data?.email;
  } catch {
    return undefined;
  }
};

/**
 * Above the admin's login form after a logout: a button that signs the editor
 * back in through Access (see lib/access-opt-out.ts). It draws nothing
 * without Access sign-in, or when the editor did not log out.
 */
export const AccessSignInLink = async () => {
  if (!accessSignInEnabled(env)) {
    return null;
  }

  const requestHeaders = await headers();
  const payload = await getPayload({ config: getPayloadConfig() });

  if (!accessOptedOut(requestHeaders, payload.config.cookiePrefix)) {
    return null;
  }

  const email = accessEmail(requestHeaders.get(ACCESS_ASSERTION_HEADER));

  return (
    <form
      action={ACCESS_SIGN_IN_PATH}
      method="post"
      style={{ marginBottom: "1.5rem" }}
    >
      <button
        className="btn btn--style-secondary btn--size-medium"
        type="submit"
      >
        {email ? `Sign in with Access as ${email}` : "Sign in with Access"}
      </button>
    </form>
  );
};
