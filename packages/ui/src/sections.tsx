import type { Block, Page, SectionOptions } from "@launch/content-model";
import { visibleSections } from "@launch/content-model";
import type { ReactNode } from "react";

import {
  Blockquote,
  CallToAction,
  CardGrid,
  Content,
  ContentMedia,
  MediaOnly,
} from "./blocks";

export const Section = ({
  options,
  children,
}: {
  options: SectionOptions;
  children: ReactNode;
}) => (
  <section
    className="l-section"
    data-pb={options.paddingBottom}
    data-pt={options.paddingTop}
    data-skin={options.skin}
    id={options.slug}
  >
    <div className="l-container" data-width={options.width}>
      {children}
    </div>
  </section>
);

export const BlockRenderer = ({
  block,
  headingLevel,
}: {
  block: Block<ReactNode>;
  headingLevel?: "h1" | "h2";
}) => {
  const level = headingLevel ? { headingLevel } : {};

  switch (block.type) {
    case "content": {
      return <Content block={block} {...level} />;
    }

    case "contentMedia": {
      return <ContentMedia block={block} {...level} />;
    }

    case "media": {
      return <MediaOnly block={block} />;
    }

    case "cardGrid": {
      return <CardGrid block={block} {...level} />;
    }

    case "blockquote": {
      return <Blockquote block={block} />;
    }

    case "callToAction": {
      return <CallToAction block={block} {...level} />;
    }

    default: {
      // Exhaustiveness check: adding a block type without a component fails typecheck.
      const unknownBlock: never = block;

      return unknownBlock;
    }
  }
};

/**
 * Renders a page's visible sections. The first section's heading becomes the
 * page's <h1> unless `firstHeadingIsTitle` is false (for pages with their own hero).
 */
export const PageSections = ({
  page,
  firstHeadingIsTitle = true,
}: {
  page: Page<ReactNode>;
  firstHeadingIsTitle?: boolean;
}) => (
  <>
    {visibleSections(page).map((section, index) => (
      <Section key={section.block.id} options={section.options}>
        <BlockRenderer
          block={section.block}
          headingLevel={index === 0 && firstHeadingIsTitle ? "h1" : "h2"}
        />
      </Section>
    ))}
  </>
);
