import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { pathTag } from "@/lib/wordpress/cache-tags";
import { wordpressEnv } from "@/lib/wordpress/env";
import { secretMatches } from "@/lib/wordpress/secret";

export const dynamic = "force-dynamic";

const RevalidateRequest = z.object({
  paths: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

/**
 * Called by the patronage-headless-revalidate mu-plugin when content is
 * published, edited, moved, unpublished or trashed: PUT {paths, tags} with
 * the shared secret in X-Headless-Secret-Key. Tags are WPGraphQL Smart Cache
 * keys (see lib/wordpress/cache-tags.ts); each path also expires its content
 * read, which may hold a "not found" from before the post was published.
 */
export const PUT = async (request: Request) => {
  const { secret } = wordpressEnv();

  if (
    !(await secretMatches(request.headers.get("x-headless-secret-key"), secret))
  ) {
    return Response.json({ message: "Invalid secret" }, { status: 401 });
  }

  const parsed = RevalidateRequest.safeParse(
    await request.json().catch(() => null)
  );

  if (!parsed.success) {
    return Response.json(
      { message: "Expected {paths: string[], tags: string[]}" },
      { status: 400 }
    );
  }

  const { paths, tags } = parsed.data;

  for (const tag of new Set([...tags, ...paths.map(pathTag)])) {
    // expire: 0 drops the entry now instead of serving it stale once more.
    revalidateTag(tag, { expire: 0 });
  }

  for (const path of paths) {
    revalidatePath(path);
  }

  return Response.json({
    now: Date.now(),
    paths,
    revalidated: paths.length + tags.length > 0,
    tags,
  });
};
