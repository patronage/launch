import {
  Container,
  Figure,
  PageSections,
  RichText as RichTextFrame,
  Section,
  Typography,
} from "@launch/ui";
import { RichText } from "@payloadcms/richtext-lexical/react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PAGE_QUERY } from "@/lib/page-query";
import { getFrontendPayload } from "@/lib/payload";
import { mediaUrl, payloadAdapter } from "@/lib/sections";
import type { Media } from "@/payload-types";

export const dynamic = "force-dynamic";

const HOME_SLUG = "home";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

/**
 * Finds the page at a path. Slugs are unique, so the last segment picks the
 * document (the home slug at /), and its nested-docs breadcrumbs must give
 * back the same path, so /home and /wrong-parent/child are not found.
 */
const findPage = async (segments: string[]) => {
  const { payload, user } = await getFrontendPayload();
  const path = `/${segments.join("/")}`;

  const { docs } = await payload.find({
    ...PAGE_QUERY,
    collection: "pages",
    limit: 1,
    overrideAccess: false,
    user,
    where: { slug: { equals: segments.at(-1) ?? HOME_SLUG } },
  });

  const [page] = docs;

  return page && payloadAdapter.pagePath(page) === path ? page : null;
};

/** The page index, shown at / until a page with the home slug exists. */
const PageIndex = async () => {
  const { payload, user } = await getFrontendPayload();

  const pages = await payload.find({
    collection: "pages",
    depth: 0,
    overrideAccess: false,
    select: { breadcrumbs: true, slug: true, title: true },
    sort: "title",
    user,
  });

  return (
    <Section paddingBottom="lg" paddingTop="lg">
      <Container className="flex flex-col gap-8">
        <Typography variant="h1">Pages</Typography>
        <ul className="grid max-w-3xl divide-y border-y" data-testid="pages">
          {pages.docs.map((page) => (
            <li key={page.id}>
              <Link
                className="hover:text-section-accent block py-3 font-medium"
                href={payloadAdapter.pagePath(page) ?? "/"}
              >
                {page.title}
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
};

const pageFor = async (params: Props["params"]) => {
  const { slug = [] } = await params;

  return { page: await findPage(slug), slug };
};

export const generateMetadata = async ({ params }: Props) => {
  const { page } = await pageFor(params);

  return page ? { title: page.title } : {};
};

const Page = async ({ params }: Props) => {
  const { page, slug } = await pageFor(params);

  if (!page) {
    if (slug.length === 0) {
      return <PageIndex />;
    }

    notFound();
  }

  if (page.layout?.length) {
    return <PageSections page={payloadAdapter.toPage(page)} />;
  }

  // SAFETY: depth 1 populates the upload, so hero is a Media document or empty.
  const hero = page.hero as Media | null | undefined;

  return (
    <Section as="article" paddingBottom="lg" paddingTop="lg">
      <Container className="flex flex-col gap-10">
        <Typography className="max-w-3xl" variant="h1">
          {page.title}
        </Typography>
        {hero?.url && (
          <Figure
            media={{
              image: {
                alt: hero.alt,
                height: hero.height ?? undefined,
                src: mediaUrl(hero.url),
                width: hero.width ?? undefined,
              },
            }}
          />
        )}
        {page.content && (
          <RichTextFrame className="max-w-3xl">
            <RichText data={page.content} />
          </RichTextFrame>
        )}
      </Container>
    </Section>
  );
};

export default Page;
