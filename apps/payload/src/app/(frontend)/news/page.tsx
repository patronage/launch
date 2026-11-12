import {
  CARD_IMAGE_SIZES,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Container,
  Img,
  Section,
  Typography,
} from "@launch/ui";
import Link from "next/link";

import { getFrontendPayload, getSiteSettings } from "@/lib/payload";
import { formatDate, NEWS_PATH, postPath } from "@/lib/posts";
import { toImage } from "@/lib/sections";
import { documentMetadata, siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const generateMetadata = async () => {
  const { siteName } = await getSiteSettings();

  return documentMetadata({
    origin: await siteOrigin(),
    path: NEWS_PATH,
    siteName,
    title: "News",
    type: "website",
  });
};

/** Published posts, featured first, then newest first. */
const NewsPage = async () => {
  const { payload, user } = await getFrontendPayload();

  const { docs: posts } = await payload.find({
    collection: "posts",
    depth: 1,
    limit: 24,
    overrideAccess: false,
    select: {
      excerpt: true,
      hero: true,
      publishedAt: true,
      slug: true,
      title: true,
    },
    sort: ["-featured", "-publishedAt"],
    user,
  });

  return (
    <Section paddingBottom="lg" paddingTop="lg">
      <Container className="flex flex-col gap-10">
        <Typography variant="h1">News</Typography>
        {posts.length === 0 ? (
          <Typography>No posts yet.</Typography>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => {
              const image = toImage(post.hero);

              return (
                <li className="flex" key={post.id}>
                  <Link className="flex w-full" href={postPath(post) ?? "/"}>
                    <Card className={image ? "w-full pt-0" : "w-full"}>
                      {image ? (
                        <Img
                          className="aspect-3/2 w-full object-cover"
                          image={image}
                          sizes={CARD_IMAGE_SIZES}
                        />
                      ) : null}
                      <CardHeader>
                        <CardDescription>
                          {formatDate(post.publishedAt)}
                        </CardDescription>
                        <CardTitle className="text-lg">{post.title}</CardTitle>
                      </CardHeader>
                      {post.excerpt ? (
                        <CardContent className="text-muted-foreground">
                          {post.excerpt}
                        </CardContent>
                      ) : null}
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Container>
    </Section>
  );
};

export default NewsPage;
