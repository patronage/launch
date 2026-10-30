import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { getFrontendPayload } from "@/lib/payload";

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

  const path = req.nextUrl.searchParams.get("path") ?? "";
  const { origin } = req.nextUrl;
  // Resolve the path the way a browser would, so "//host", "/\\host" and
  // control characters that browsers strip cannot point it off this site.
  const target = new URL(path, origin);

  if (!path.startsWith("/") || target.origin !== origin) {
    return new Response("Expected a path on this site.", { status: 400 });
  }

  const draft = await draftMode();

  draft.enable();
  redirect(`${target.pathname}${target.search}${target.hash}`);
};
