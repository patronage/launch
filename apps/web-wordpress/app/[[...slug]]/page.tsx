import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContentView } from "@/components/content-view";
import { getContentByUri } from "@/lib/wordpress/content";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

// Pages render on first request and stay cached until WordPress revalidates
// them on publish. The hourly timer is a safety net for a missed webhook.
export const revalidate = 3600;
export const dynamicParams = true;

export const generateStaticParams = () => [];

const toUri = (slug: string[] = []): string =>
  slug.length > 0 ? `/${slug.map(encodeURIComponent).join("/")}/` : "/";

export const generateMetadata = async ({
  params,
}: Props): Promise<Metadata> => {
  const { slug } = await params;
  const content = await getContentByUri(toUri(slug));

  return content && "title" in content && content.title
    ? { title: content.title }
    : {};
};

const WordPressPage = async ({ params }: Props) => {
  const { slug } = await params;
  const content = await getContentByUri(toUri(slug));

  if (!content) {
    notFound();
  }

  return <ContentView content={content} />;
};

export default WordPressPage;
