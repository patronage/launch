import { draftMode } from "next/headers";
import { redirect } from "next/navigation";

import { wordpressEnv } from "@/lib/wordpress/env";
import { verifyPreviewToken } from "@/lib/wordpress/preview-token";

export const dynamic = "force-dynamic";

/** WordPress's Preview button lands here with a signed token for one post. */
export const GET = async (request: Request) => {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const postId = await verifyPreviewToken(token, wordpressEnv().secret);

  if (postId === null) {
    return new Response("Invalid or expired preview link", { status: 401 });
  }

  const draft = await draftMode();

  draft.enable();
  redirect(`/preview/${postId}/`);
};
