import type { Block, Page, SectionOptions } from "@launch/content-model";
import { visibleSections } from "@launch/content-model";
import type { ReactNode } from "react";

import {
  Blockquote,
  CallToAction,
  CardGrid,
  Content,
  ContentMedia,
  FormSection,
  MediaOnly,
} from "./blocks";
import { Container } from "./components/container";
import { Section } from "./components/section";

/** A CMS section: its options become a Section and Container around the block. */
export const PageSection = ({
  options,
  children,
}: {
  options: SectionOptions;
  children: ReactNode;
}) => (
  <Section
    id={options.slug}
    paddingBottom={options.paddingBottom}
    paddingTop={options.paddingTop}
    skin={options.skin}
  >
    <Container width={options.width}>{children}</Container>
  </Section>
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

    case "form": {
      return <FormSection block={block} {...level} />;
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
      <PageSection key={section.block.id} options={section.options}>
        <BlockRenderer
          block={section.block}
          headingLevel={index === 0 && firstHeadingIsTitle ? "h1" : "h2"}
        />
      </PageSection>
    ))}
  </>
);
