import { draftMode } from "next/headers";
import { redirect } from "next/navigation";

import { sameSitePath } from "@/lib/same-site-path";

export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const draft = await draftMode();
  const url = new URL(request.url);

  draft.disable();
  // Only paths on this site, so this cannot be used as an open redirect.
  redirect(
    sameSitePath(url.searchParams.get("path") ?? "/", url.origin) ?? "/"
  );
};
