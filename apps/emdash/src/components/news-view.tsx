import type { NewsSummary, TermLink } from "@launch/content-model";
import {
  Container,
  formatNewsDate,
  Img,
  NewsCard,
  NewsCardGrid,
  NewsPagination,
  RichText,
  Section,
  Typography,
} from "@launch/ui";
import type { ReactNode } from "react";

/**
 * A listing's cards and its older/newer links, also served on their own as
 * the load-more fragment. `data-news-cards` and `data-news-more` are what
 * src/scripts/news-more.ts looks for.
 */
export const NewsCards = ({
  newerHref,
  olderHref,
  stories,
}: {
  newerHref?: string | undefined;
  olderHref?: string | undefined;
  stories: NewsSummary[];
}) => (
  <div className="flex flex-col gap-10" data-news-listing="">
    <NewsCardGrid data-news-cards="">
      {stories.map((story) => (
        <NewsCard key={story.id} story={story} />
      ))}
    </NewsCardGrid>
    <NewsPagination newerHref={newerHref} olderHref={olderHref} />
  </div>
);

/** The news listing or an archive: a heading, an optional intro and the cards. */
export const NewsListing = ({
  eyebrow,
  heading,
  intro,
  children,
  empty,
}: {
  eyebrow?: string | undefined;
  heading: string;
  intro?: string | undefined;
  children: ReactNode;
  empty: boolean;
}) => (
  <Section paddingBottom="lg" paddingTop="lg">
    <Container className="flex flex-col gap-10">
      <header className="flex max-w-2xl flex-col gap-3">
        {eyebrow ? (
          <Typography as="p" variant="eyebrow">
            {eyebrow}
          </Typography>
        ) : null}
        <Typography as="h1" variant="h1">
          {heading}
        </Typography>
        {intro ? <Typography variant="lead">{intro}</Typography> : null}
      </header>
      {empty ? <Typography>No stories yet.</Typography> : children}
    </Container>
  </Section>
);

/** One story: its category, title, date, image, body and tags. */
export const NewsStory = ({
  body,
  story,
  tags,
}: {
  body: ReactNode;
  story: NewsSummary;
  tags: TermLink[];
}) => (
  <article>
    <Section paddingBottom="md" paddingTop="lg">
      <Container width="narrow">
        <header className="flex flex-col gap-4">
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
            {story.category ? (
              <a
                className="text-primary font-medium hover:underline"
                href={story.category.href}
              >
                {story.category.label}
              </a>
            ) : null}
            {story.category && story.publishedAt ? (
              <span aria-hidden="true">·</span>
            ) : null}
            {story.publishedAt ? (
              <time dateTime={story.publishedAt}>
                {formatNewsDate(story.publishedAt)}
              </time>
            ) : null}
          </p>
          <Typography as="h1" variant="h1">
            {story.title}
          </Typography>
          {story.excerpt ? (
            <Typography variant="lead">{story.excerpt}</Typography>
          ) : null}
        </header>
      </Container>
    </Section>
    {story.image ? (
      <Section paddingBottom="none" paddingTop="none">
        <Container width="wide">
          <Img
            className="aspect-3/2 w-full rounded-xl object-cover"
            image={story.image}
            loading="eager"
            sizes="(min-width: 1280px) 1200px, 100vw"
          />
        </Container>
      </Section>
    ) : null}
    <Section paddingBottom="lg" paddingTop="md">
      <Container width="narrow">
        <RichText>{body}</RichText>
        {tags.length > 0 ? (
          <ul aria-label="Tags" className="mt-10 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <li key={tag.href}>
                <a
                  className="bg-muted text-foreground hover:bg-accent rounded-full px-3 py-1 text-sm"
                  href={tag.href}
                >
                  {tag.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-10">
          <a className="text-primary font-medium hover:underline" href="/news">
            All news
          </a>
        </p>
      </Container>
    </Section>
  </article>
);
