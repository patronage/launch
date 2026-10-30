import {
  Container,
  Figure,
  PageHero,
  PageSections,
  RichText as RichTextFrame,
  Section,
  Typography,
} from "@launch/ui";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LivePreviewRefresh } from "@/components/live-preview-refresh";
import { PayloadRichText } from "@/components/rich-text";
import { PAGE_QUERY } from "@/lib/page-query";
import { getFrontendPayload } from "@/lib/payload";
import { payloadAdapter, toImage } from "@/lib/sections";
import type { Page as PayloadPage } from "@/payload-types";

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
  const { draft, payload, user } = await getFrontendPayload();
  const path = `/${segments.join("/")}`;

  const { docs } = await payload.find({
    ...PAGE_QUERY,
    collection: "pages",
    draft,
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

/** The page's rich text, for pages without sections. */
const PageContent = ({ page }: { page: PayloadPage }) =>
  page.content ? (
    <RichTextFrame className="max-w-3xl">
      <PayloadRichText data={page.content} />
    </RichTextFrame>
  ) : null;

/**
 * The page's hero and sections. A page without sections shows its rich text
 * under the hero, or under its title and hero image as an article.
 */
const PageBody = ({ page }: { page: PayloadPage }) => {
  const model = payloadAdapter.toPage(page);

  if (model.sections.length > 0) {
    return <PageSections page={model} />;
  }

  if (model.hero) {
    return (
      <>
        <PageHero hero={model.hero} />
        {page.content && (
          <Section paddingBottom="lg" paddingTop="md">
            <Container>
              <PageContent page={page} />
            </Container>
          </Section>
        )}
      </>
    );
  }

  const image = toImage(page.hero?.image);

  return (
    <Section as="article" paddingBottom="lg" paddingTop="lg">
      <Container className="flex flex-col gap-10">
        <Typography className="max-w-3xl" variant="h1">
          {page.title}
        </Typography>
        {image && <Figure media={{ image }} />}
        <PageContent page={page} />
      </Container>
    </Section>
  );
};

const Page = async ({ params }: Props) => {
  const { page, slug } = await pageFor(params);

  if (!page) {
    if (slug.length === 0) {
      return <PageIndex />;
    }

    notFound();
  }

  const { draft } = await getFrontendPayload();

  return (
    <>
      {draft && <LivePreviewRefresh />}
      <PageBody page={page} />
    </>
  );
};

export default Page;
