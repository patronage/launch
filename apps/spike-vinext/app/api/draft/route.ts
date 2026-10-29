import { env } from "cloudflare:workers";
import { draftMode } from "next/headers";
import { redirect } from "next/navigation";

// GET /api/draft?secret=...&slug=hello   enables draft mode, then redirects
// GET /api/draft?disable=1&slug=hello     turns it off
export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") ?? "hello";
  const draft = await draftMode();

  if (url.searchParams.has("disable")) {
    draft.disable();
  } else {
    if (
      !env.PREVIEW_SECRET ||
      url.searchParams.get("secret") !== env.PREVIEW_SECRET
    ) {
      return Response.json(
        { error: "unauthorized", ok: false },
        { status: 401 }
      );
    }

    draft.enable();
  }

  redirect(`/posts/${encodeURIComponent(slug)}`);
};
