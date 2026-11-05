import { ACCESS_ASSERTION_HEADER, verifyAccessJwt } from "@patronage/access";
import { APIError } from "payload";
import type { CollectionBeforeOperationHook } from "payload";
import { z } from "zod";

import { isLocalRequest } from "./local-login";

/** Payload's first-user endpoint, which the admin's create-first-user page posts to. */
const FIRST_REGISTER = /\/users\/first-register\/?$/u;

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

/** A users `beforeOperation` hook that refuses the first user unless {@link firstUserAllowed}. */
export const guardFirstUser =
  (access: () => FirstUserAccess): CollectionBeforeOperationHook =>
  async ({ args, operation, req }) => {
    if (
      operation !== "create" ||
      !req.url ||
      !FIRST_REGISTER.test(new URL(req.url, "http://localhost").pathname)
    ) {
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
