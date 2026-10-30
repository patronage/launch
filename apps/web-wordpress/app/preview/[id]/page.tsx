import { draftMode } from "next/headers";
import { notFound } from "next/navigation";

import { ContentView } from "@/components/content-view";
import { getPreviewContent } from "@/lib/wordpress/content";

interface Props {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

/** Where Exit preview returns to: the post's own path, or home for a draft without one. */
const exitPath = (uri: string | null | undefined): string =>
  uri && !uri.startsWith("/?") ? uri : "/";

/**
 * Drafts have no URI of their own, so every preview renders here, by ID.
 * Keeping draftMode() out of the shared layout lets public pages stay cacheable.
 */
const PreviewPage = async ({ params }: Props) => {
  const [{ isEnabled }, { id }] = await Promise.all([draftMode(), params]);
  const postId = Number(id);

  if (!(isEnabled && Number.isInteger(postId))) {
    notFound();
  }

  const content = await getPreviewContent(postId);

  if (!content) {
    notFound();
  }

  const state =
    content.status === "publish"
      ? "unsaved changes"
      : `a ${content.status ?? "draft"}`;

  return (
    <>
      <p className="px-gutter bg-amber-100 py-2 text-sm text-amber-950">
        Previewing {state}.{" "}
        <a
          className="font-medium underline underline-offset-4"
          href={`/api/exit-preview/?path=${encodeURIComponent(exitPath(content.uri))}`}
        >
          Exit preview
        </a>
      </p>
      <ContentView content={content} />
    </>
  );
};

export default PreviewPage;
