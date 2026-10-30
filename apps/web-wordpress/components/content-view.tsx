import {
  Container,
  PageSections,
  RichText,
  Section,
  Typography,
} from "@launch/ui";

import type { Content } from "@/lib/wordpress/content";
import { toSectionsPage } from "@/lib/wordpress/sections";

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-US", { dateStyle: "long" });

/** The title, and for a post its author and date. */
const Header = ({ content }: { content: Content }) => (
  <Section as="header" paddingBottom="sm" paddingTop="lg">
    <Container>
      <div className="flex max-w-3xl flex-col gap-5">
        <Typography variant="h1">
          {"title" in content ? content.title : null}
        </Typography>
        {content.__typename === "Post" && (
          <Typography variant="muted">
            {content.author?.node.name}
            {content.date && ` · ${formatDate(content.date)}`}
          </Typography>
        )}
      </div>
    </Container>
  </Section>
);

/**
 * Renders a page or post from WordPress. A page with a hero or Page Builder
 * sections renders through @launch/ui, where the hero (or else the first
 * section's heading) is the <h1>; everything else shows its title and the
 * block editor's HTML.
 */
export const ContentView = ({ content }: { content: Content }) => {
  const sections = toSectionsPage(content);
  const html = "content" in content ? content.content : null;

  if (sections) {
    return <PageSections page={sections} />;
  }

  return (
    <article>
      <Header content={content} />
      {html && (
        <Section as="div" paddingBottom="lg" paddingTop="none">
          <Container>
            <RichText className="max-w-3xl">
              <div
                className="l-rich-raw"
                // oxlint-disable-next-line react/no-danger -- block editor HTML, written by signed-in editors (see docs/spikes/03-cms-neutral-sections.md).
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </RichText>
          </Container>
        </Section>
      )}
    </article>
  );
};
