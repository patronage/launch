import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { getFrontendPayload } from "@/lib/payload";
import { sameSitePath } from "@/lib/same-site-path";

/**
 * The admin's preview button and Live Preview open this route. For a
 * logged-in editor it turns on draft mode, so the front end reads the latest
 * draft, then redirects to the page's path on this site.
 */
export const GET = async (req: NextRequest): Promise<Response> => {
  const { user } = await getFrontendPayload();

  if (!user) {
    return new Response("Log in to the admin to preview drafts.", {
      status: 403,
    });
  }

  // Resolved the way a browser would, so "//host", "/\\host" and control
  // characters that browsers strip cannot point it off this site.
  const target = sameSitePath(
    req.nextUrl.searchParams.get("path") ?? "",
    req.nextUrl.origin
  );

  if (target === undefined) {
    return new Response("Expected a path on this site.", { status: 400 });
  }

  const draft = await draftMode();

  draft.enable();
  redirect(target);
};
