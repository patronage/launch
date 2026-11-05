import { ACCESS_ASSERTION_HEADER, verifyAccessJwt } from "@patronage/access";
import { APIError } from "payload";
import type { CollectionBeforeOperationHook } from "payload";
import { z } from "zod";

import { isLocalRequest } from "./local-login";

/** The part of the create operation's arguments the guard reads. */
const FirstUserArgs = z.object({ data: z.object({ email: z.string() }) });

export interface FirstUserAccess {
  audience?: string;
  teamDomain?: string;
}

/**
 * Who may create the first user: a request made on this machine, or one
 * carrying a verified Cloudflare Access login for the same email. Payload
 * itself lets anyone create the first user while the users collection is
 * empty, so a fresh deploy reached before Access protects it would hand the
 * CMS to whoever got there first.
 */
export const firstUserAllowed = async (
  headers: Headers,
  email: string | undefined,
  access: FirstUserAccess
): Promise<boolean> => {
  if (isLocalRequest(headers)) {
    return true;
  }

  if (!access.teamDomain || !access.audience || !email) {
    return false;
  }

  const result = await verifyAccessJwt(headers.get(ACCESS_ASSERTION_HEADER), {
    audience: access.audience,
    teamDomain: access.teamDomain,
  });

  return (
    result.ok &&
    result.identity.kind === "user" &&
    result.identity.email.toLowerCase() === email.trim().toLowerCase()
  );
};

/**
 * A users `beforeOperation` hook that refuses a create made with no signed-in
 * user while the collection is empty, unless {@link firstUserAllowed}. It
 * keys on the operation, not the URL, so no spelling of Payload's
 * first-register route gets past it. Trusted server code with no request
 * headers (a seed) is refused too; it runs on this machine or signs in first.
 */
export const guardFirstUser =
  (access: () => FirstUserAccess): CollectionBeforeOperationHook =>
  async ({ args, collection, operation, req }) => {
    if (operation !== "create" || req.user) {
      return args;
    }

    const { totalDocs } = await req.payload.count({
      collection: collection.slug,
      overrideAccess: true,
      req,
    });

    if (totalDocs > 0) {
      return args;
    }

    const email = FirstUserArgs.safeParse(args).data?.data.email;

    if (!(await firstUserAllowed(req.headers, email, access()))) {
      throw new APIError(
        "Create the first user through Cloudflare Access, signed in with the same email, or on localhost.",
        403,
        undefined,
        true
      );
    }

    return args;
  };
