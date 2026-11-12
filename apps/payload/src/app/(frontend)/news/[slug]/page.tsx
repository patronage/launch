import {
  Container,
  Figure,
  RichText as RichTextFrame,
  Section,
  Typography,
} from "@launch/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { LivePreviewRefresh } from "@/components/live-preview-refresh";
import { PayloadRichText } from "@/components/rich-text";
import { followRedirect } from "@/lib/follow-redirect";
import { getFrontendPayload, getSiteSettings } from "@/lib/payload";
import { formatDate, NEWS_PATH, postPath } from "@/lib/posts";
import { toImage } from "@/lib/sections";
import { documentMetadata, siteOrigin } from "@/lib/seo";
import type { Author, Category } from "@/payload-types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Reads a post by slug: the latest draft in preview, else the published one.
 * Cached per request by slug, so generateMetadata and the page share a read.
 */
const findPostBySlug = cache(async (slug: string) => {
  const { draft, payload, user } = await getFrontendPayload();

  const {
    docs: [post],
  } = await payload.find({
    collection: "posts",
    depth: 1,
    draft,
    limit: 1,
    overrideAccess: false,
    user,
    where: { slug: { equals: slug } },
  });

  return { draft, post };
});

const findPost = async (params: Props["params"]) => {
  const { slug } = await params;

  return findPostBySlug(slug);
};

/** At depth 1 relationships are documents; ids mean the reader lacks access. */
const populated = <T extends object>(values: (number | T)[] | null = []) =>
  (values ?? []).filter((value): value is T => typeof value === "object");

export const generateMetadata = async ({ params }: Props) => {
  const { post } = await findPost(params);

  if (!post) {
    return {};
  }

  const { siteName } = await getSiteSettings();

  return documentMetadata({
    description: post.excerpt,
    fallbackImage: toImage(post.hero),
    image: toImage(post.meta?.image),
    meta: post.meta,
    origin: await siteOrigin(),
    path: postPath(post) ?? NEWS_PATH,
    siteName,
    title: post.title,
    type: "article",
  });
};

const PostPage = async ({ params }: Props) => {
  const { draft, post } = await findPost(params);

  if (!post) {
    const { slug } = await params;

    await followRedirect(`${NEWS_PATH}/${slug}`);
    notFound();
  }

  const hero = toImage(post.hero);
  const authors = populated<Author>(post.authors);
  const categories = populated<Category>(post.categories);

  return (
    <>
      {draft && <LivePreviewRefresh />}
      <Section as="article" paddingBottom="lg" paddingTop="lg">
        <Container className="flex flex-col gap-8" width="narrow">
          <Link
            className="hover:text-section-accent text-sm font-medium"
            href={NEWS_PATH}
          >
            ← News
          </Link>
          <header className="flex flex-col gap-4">
            {categories.length > 0 ? (
              <Typography variant="eyebrow">
                {categories.map((category) => category.title).join(" · ")}
              </Typography>
            ) : null}
            <Typography variant="h1">{post.title}</Typography>
            {post.excerpt ? (
              <Typography variant="lead">{post.excerpt}</Typography>
            ) : null}
            <Typography variant="muted">
              {[
                authors.map((author) => author.name).join(", "),
                formatDate(post.publishedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Typography>
          </header>
          {hero ? (
            // The narrow container is at most max-w-2xl (42rem) wide.
            <Figure
              media={{ image: hero }}
              sizes="(min-width: 42rem) 42rem, 100vw"
            />
          ) : null}
          {post.content ? (
            <RichTextFrame>
              <PayloadRichText data={post.content} />
            </RichTextFrame>
          ) : null}
        </Container>
      </Section>
    </>
  );
};

export default PostPage;
