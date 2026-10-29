import { env } from "cloudflare:workers";
import { revalidatePath, revalidateTag } from "next/cache";

// POST /api/revalidate?tag=post:hello  or  ?path=/posts/hello
// The CMS webhook sends the shared secret in x-revalidate-secret.
export function POST(request: Request) {
  if (!env.REVALIDATE_SECRET || request.headers.get("x-revalidate-secret") !== env.REVALIDATE_SECRET) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const tags = url.searchParams.getAll("tag");
  const paths = url.searchParams.getAll("path");
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  for (const path of paths) revalidatePath(path);
  return Response.json({ ok: true, tags, paths });
}
