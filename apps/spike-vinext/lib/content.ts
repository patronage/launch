import { cacheLife, cacheTag } from "next/cache";

export interface Post {
  slug: string;
  title: string;
  generatedAt: string;
}

export type UpstreamResult =
  | { ok: true; status: number; body: string }
  | { ok: false; error: string };

export const now = () => new Date().toISOString();

// Stand-in for a CMS query. "use cache" stores the result in the data cache
// (KV in production) under the tags below, so revalidateTag() can drop it.
export const getPost = async (slug: string): Promise<Post> => {
  "use cache";
  cacheTag("posts", `post:${slug}`);
  cacheLife("hours");

  // "use cache" functions must be async; a real CMS query would await here.
  return await Promise.resolve({
    generatedAt: now(),
    slug,
    title: `Post ${slug}`,
  });
};

// Same data read with draft mode on: never cached.
export const getDraftPost = (slug: string): Post => ({
  generatedAt: now(),
  slug,
  title: `Post ${slug} (draft)`,
});

// Exercises the patched fetch() cache. UPSTREAM_URL is a plain-text binding.
export const getUpstream = async (
  url: string | undefined
): Promise<UpstreamResult> => {
  if (!url) {
    return { error: "UPSTREAM_URL is not set", ok: false };
  }

  try {
    const res = await fetch(url, {
      next: { revalidate: 3600, tags: ["upstream"] },
    });

    const text = await res.text();

    return { body: text.slice(0, 200), ok: true, status: res.status };
  } catch (error) {
    return { error: String(error), ok: false };
  }
};
