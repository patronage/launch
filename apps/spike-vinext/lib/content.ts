import { cacheLife, cacheTag } from "next/cache";

export type Post = {
  slug: string;
  title: string;
  generatedAt: string;
};

// Stand-in for a CMS query. "use cache" stores the result in the data cache
// (KV in production) under the tags below, so revalidateTag() can drop it.
export async function getPost(slug: string): Promise<Post> {
  "use cache";
  cacheTag("posts", `post:${slug}`);
  cacheLife("hours");
  return { slug, title: `Post ${slug}`, generatedAt: new Date().toISOString() };
}

// Same data read with draft mode on: never cached.
export async function getDraftPost(slug: string): Promise<Post> {
  return { slug, title: `Post ${slug} (draft)`, generatedAt: new Date().toISOString() };
}

// Exercises the patched fetch() cache. UPSTREAM_URL is a plain-text binding.
export async function getUpstream(url: string | undefined) {
  if (!url) return { ok: false as const, error: "UPSTREAM_URL is not set" };
  try {
    const res = await fetch(url, { next: { tags: ["upstream"], revalidate: 3600 } });
    return { ok: true as const, status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (error) {
    return { ok: false as const, error: String(error) };
  }
}
