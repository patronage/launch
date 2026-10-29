import { RichText } from "@payloadcms/richtext-lexical/react";
import { notFound } from "next/navigation";

import { getFrontendPayload } from "@/lib/payload";
import type { Media } from "@/payload-types";

export const dynamic = "force-dynamic";

const Page = async ({ params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const { payload, user } = await getFrontendPayload();

  const { docs } = await payload.find({
    collection: "pages",
    depth: 1,
    limit: 1,
    overrideAccess: false,
    user,
    where: { slug: { equals: slug } },
  });

  const [page] = docs;

  if (!page) {
    notFound();
  }

  // SAFETY: depth 1 populates the upload, so hero is a Media document or empty.
  const hero = page.hero as Media | null | undefined;

  return (
    <article className="content">
      <h1>{page.title}</h1>
      {hero?.url && <img alt={hero.alt} src={hero.url} width={480} />}
      {page.content && <RichText data={page.content} />}
    </article>
  );
};

export default Page;
