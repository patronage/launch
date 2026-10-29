import { draftMode } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const GET = async (request: Request) => {
  const draft = await draftMode();
  const path = new URL(request.url).searchParams.get("path") ?? "/";

  draft.disable();
  // Only same-site paths, so this cannot be used as an open redirect.
  redirect(path.startsWith("/") && !path.startsWith("//") ? path : "/");
};
