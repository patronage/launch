import { env } from "cloudflare:workers";
import { draftMode } from "next/headers";

import { getDraftPost, getPost, getUpstream, now } from "@/lib/content";

export const revalidate = 3600;

// No paths are built ahead of time; each slug is rendered on first request
// and then served from the ISR cache. Without this export the route is dynamic.
export const generateStaticParams = () => [];

const PostPage = async ({ params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const { isEnabled: isDraft } = await draftMode();
  const post = isDraft ? getDraftPost(slug) : await getPost(slug);
  const upstream = await getUpstream(env.UPSTREAM_URL);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-10">
      {isDraft ? (
        <p className="rounded bg-amber-100 px-3 py-2">Draft mode is on</p>
      ) : null}
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Page rendered</dt>
        <dd data-testid="rendered">{now()}</dd>
        <dt>Data generated</dt>
        <dd data-testid="generated">{post.generatedAt}</dd>
        <dt>Upstream fetch</dt>
        <dd data-testid="upstream">{JSON.stringify(upstream)}</dd>
      </dl>
    </main>
  );
};

export default PostPage;
