import type { NewsSummary } from "@launch/content-model";
import type { ComponentProps, ElementType } from "react";

import { buttonVariants } from "./components/button";
import { Card, CardContent, CardHeader } from "./components/card";
import { Typography } from "./components/typography";
import { CARD_IMAGE_SIZES, Img } from "./primitives";
import { cn } from "./utils";

/** A story's date as readers see it, e.g. October 30, 2026. */
export const formatNewsDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });

/**
 * One story in a listing, as a list item. The title links to the story and
 * stretches over the card; the category links to its archive above that.
 */
export const NewsCard = ({
  headingLevel = "h2",
  story,
}: {
  headingLevel?: ElementType;
  story: NewsSummary;
}) => (
  <li className="flex">
    <Card
      className={cn(
        "hover:border-primary relative w-full transition-colors",
        story.image ? "pt-0" : undefined
      )}
    >
      {story.image ? (
        <Img
          className="aspect-3/2 w-full object-cover"
          image={story.image}
          sizes={CARD_IMAGE_SIZES}
        />
      ) : null}
      <CardHeader className="gap-2">
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
          {story.category ? (
            <a
              className="text-primary relative z-10 font-medium hover:underline"
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
        <Typography as={headingLevel} variant="h4">
          <a
            className="focus-visible:after:ring-ring/50 after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-[3px]"
            href={story.href}
          >
            {story.title}
          </a>
        </Typography>
      </CardHeader>
      {story.excerpt ? (
        <CardContent className="text-muted-foreground">
          {story.excerpt}
        </CardContent>
      ) : null}
    </Card>
  </li>
);

/** The grid a listing's `NewsCard`s go in. */
export const NewsCardGrid = ({ className, ...props }: ComponentProps<"ul">) => (
  <ul
    className={cn("grid gap-6 sm:grid-cols-2 lg:grid-cols-3", className)}
    {...props}
  />
);

/**
 * Links to a listing's older and newer pages. The older link carries
 * `data-news-more`, which a page's load-more script can take over.
 */
export const NewsPagination = ({
  newerHref,
  olderHref,
}: {
  newerHref?: string | undefined;
  olderHref?: string | undefined;
}) => {
  if (!(newerHref || olderHref)) {
    return null;
  }

  return (
    <nav
      aria-label="More stories"
      className="flex flex-wrap items-center justify-center gap-3"
    >
      {newerHref ? (
        <a
          className={buttonVariants({ size: "lg", variant: "outline" })}
          href={newerHref}
          rel="prev"
        >
          Newer stories
        </a>
      ) : null}
      {olderHref ? (
        <a
          className={buttonVariants({ size: "lg", variant: "default" })}
          data-news-more=""
          href={olderHref}
          rel="next"
        >
          Older stories
        </a>
      ) : null}
    </nav>
  );
};
