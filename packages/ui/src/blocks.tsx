import type {
  BlockquoteBlock,
  CallToActionBlock,
  CardGridBlock,
  ContentBlock,
  ContentMediaBlock,
  MediaBlock,
} from "@launch/content-model";
import type { ReactNode } from "react";

import { Figure, Heading, Img, LinkList, RichText } from "./primitives";

/** Shared props: `headingLevel` lets the page decide the outline, not the block. */
interface BlockProps<B> {
  block: B;
  headingLevel?: "h1" | "h2";
}

export const Content = ({
  block,
  headingLevel = "h2",
}: BlockProps<ContentBlock<ReactNode>>) => (
  <div className="l-content" data-align={block.align}>
    {block.eyebrow ? <p className="l-eyebrow">{block.eyebrow}</p> : null}
    <Heading
      as={headingLevel}
      className={headingLevel === "h1" ? "l-display" : "l-title"}
    >
      {block.heading}
    </Heading>
    <RichText>{block.body}</RichText>
    <LinkList links={block.links} />
  </div>
);

export const ContentMedia = ({
  block,
  headingLevel = "h2",
}: BlockProps<ContentMediaBlock<ReactNode>>) => (
  <div className="l-content-media" data-media={block.mediaPosition}>
    <div className="l-content">
      {block.eyebrow ? <p className="l-eyebrow">{block.eyebrow}</p> : null}
      <Heading as={headingLevel}>{block.heading}</Heading>
      <RichText>{block.body}</RichText>
      <LinkList links={block.links} />
    </div>
    <Figure media={block.media} />
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
  const CardTitle = block.heading ? cardHeading : headingLevel;

  return (
    <div className="l-card-grid">
      <Heading as={headingLevel}>{block.heading}</Heading>
      <ul className="l-cards" data-columns={block.columns}>
        {block.cards.map((card) => (
          <li className="l-card" key={card.id}>
            {card.image ? <Img image={card.image} /> : null}
            <div className="l-card-body">
              <CardTitle className="l-card-title">{card.title}</CardTitle>
              {card.text ? <p className="l-card-text">{card.text}</p> : null}
              {card.link ? <LinkList links={[card.link]} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const Blockquote = ({ block }: BlockProps<BlockquoteBlock>) => {
  const hasCaption = block.attribution || block.role;

  return (
    <figure className="l-quote">
      {block.image ? <Img image={{ ...block.image, alt: "" }} /> : null}
      <blockquote>
        <p>{block.quote}</p>
      </blockquote>
      {hasCaption ? (
        <figcaption>
          {block.attribution ? <cite>{block.attribution}</cite> : null}
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
  <div className="l-cta">
    <Heading as={headingLevel}>{block.heading}</Heading>
    <RichText>{block.body}</RichText>
    <LinkList links={block.links} />
  </div>
);
