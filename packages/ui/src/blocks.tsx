import type {
  BlockquoteBlock,
  CallToActionBlock,
  CardGridBlock,
  ContentBlock,
  ContentMediaBlock,
  FormBlock,
  MediaBlock,
} from "@launch/content-model";
import type { ReactNode } from "react";

import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
} from "./components/card";
import { Form } from "./components/form";
import { Typography } from "./components/typography";
import { Figure, Img, LinkList, RichText } from "./primitives";
import { cn } from "./utils";

/** Shared props: `headingLevel` lets the page decide the outline, not the block. */
interface BlockProps<B> {
  block: B;
  headingLevel?: "h1" | "h2";
}

/** Eyebrow, heading, rich text and links: the copy column most blocks share. */
const Copy = ({
  align = "start",
  body,
  eyebrow,
  heading,
  headingLevel,
  links,
}: {
  align?: "start" | "center";
  body?: ReactNode;
  eyebrow?: string | undefined;
  heading?: string | undefined;
  headingLevel: "h1" | "h2";
  links: ContentBlock<ReactNode>["links"];
}) => (
  <div
    className={cn(
      "flex flex-col gap-5",
      align === "center" && "mx-auto items-center text-center"
    )}
  >
    {eyebrow ? <Typography variant="eyebrow">{eyebrow}</Typography> : null}
    {heading ? (
      <Typography
        as={headingLevel}
        variant={headingLevel === "h1" ? "d1" : "h2"}
      >
        {heading}
      </Typography>
    ) : null}
    <RichText className={cn(align === "center" && "mx-auto")}>{body}</RichText>
    <LinkList
      className={cn("mt-2", align === "center" && "justify-center")}
      links={links}
    />
  </div>
);

export const Content = ({
  block,
  headingLevel = "h2",
}: BlockProps<ContentBlock<ReactNode>>) => (
  <div
    className="max-w-3xl data-[align=center]:mx-auto"
    data-align={block.align}
  >
    <Copy
      align={block.align}
      body={block.body}
      eyebrow={block.eyebrow}
      heading={block.heading}
      headingLevel={headingLevel}
      links={block.links}
    />
  </div>
);

export const ContentMedia = ({
  block,
  headingLevel = "h2",
}: BlockProps<ContentMediaBlock<ReactNode>>) => (
  <div
    className="grid items-center gap-10 md:grid-cols-2 lg:gap-16"
    data-media={block.mediaPosition}
  >
    <Copy
      body={block.body}
      eyebrow={block.eyebrow}
      heading={block.heading}
      headingLevel={headingLevel}
      links={block.links}
    />
    <Figure
      className={cn(block.mediaPosition === "start" && "md:order-first")}
      media={block.media}
    />
  </div>
);

export const MediaOnly = ({ block }: BlockProps<MediaBlock>) => (
  <Figure media={block.media} />
);

export const CardGrid = ({
  block,
  headingLevel = "h2",
}: BlockProps<CardGridBlock>) => {
  const cardHeading = headingLevel === "h1" ? "h2" : "h3";
  const cardTitle = block.heading ? cardHeading : headingLevel;

  return (
    <div className="flex flex-col gap-10">
      {block.heading ? (
        <Typography
          as={headingLevel}
          variant={headingLevel === "h1" ? "d1" : "h2"}
        >
          {block.heading}
        </Typography>
      ) : null}
      <ul
        className={cn(
          "grid gap-6 sm:grid-cols-2",
          block.columns === 3 && "lg:grid-cols-3",
          block.columns === 4 && "lg:grid-cols-4"
        )}
        data-columns={block.columns}
      >
        {block.cards.map((card) => (
          <li className="flex" key={card.id}>
            <Card className={cn("w-full", card.image && "pt-0")}>
              {card.image ? (
                <Img
                  className="aspect-3/2 w-full object-cover"
                  image={card.image}
                />
              ) : null}
              <CardHeader>
                <Typography as={cardTitle} variant="h4">
                  {card.title}
                </Typography>
                {card.text ? (
                  <CardDescription className="text-base leading-relaxed">
                    {card.text}
                  </CardDescription>
                ) : null}
              </CardHeader>
              {card.link ? (
                <CardFooter>
                  <LinkList links={[{ ...card.link, variant: "text" }]} />
                </CardFooter>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const Blockquote = ({ block }: BlockProps<BlockquoteBlock>) => {
  const hasCaption = block.attribution || block.role;

  return (
    <figure className="mx-auto flex max-w-3xl flex-col items-center gap-8 text-center">
      {block.image ? (
        <Img
          className="size-16 rounded-full object-cover"
          image={{ ...block.image, alt: "" }}
        />
      ) : null}
      <Typography as="blockquote" variant="quote">
        <p>{block.quote}</p>
      </Typography>
      {hasCaption ? (
        <figcaption className="text-section-muted">
          {block.attribution ? (
            <cite className="text-section-heading font-semibold not-italic">
              {block.attribution}
            </cite>
          ) : null}
          {block.attribution && block.role ? ", " : null}
          {block.role}
        </figcaption>
      ) : null}
    </figure>
  );
};

export const CallToAction = ({
  block,
  headingLevel = "h2",
}: BlockProps<CallToActionBlock<ReactNode>>) => (
  <div className="mx-auto max-w-3xl">
    <Copy
      align="center"
      body={block.body}
      heading={block.heading}
      headingLevel={headingLevel}
      links={block.links}
    />
  </div>
);

/** Heading and intro above a CMS-defined form, at reading width. */
export const FormSection = ({
  block,
  headingLevel = "h2",
}: BlockProps<FormBlock<ReactNode>>) => (
  <div className="flex max-w-2xl flex-col gap-10">
    {block.heading || block.body ? (
      <Copy
        body={block.body}
        heading={block.heading}
        headingLevel={headingLevel}
        links={[]}
      />
    ) : null}
    <Form form={block.form} />
  </div>
);
