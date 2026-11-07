import {
  Container,
  PageSections,
  RichText,
  Section,
  Typography,
} from "@launch/ui";

import type { Content } from "@/lib/wordpress/content";
import { toSectionsPage, withMediaImages } from "@/lib/wordpress/sections";

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-US", { dateStyle: "long" });

/** A post's author and date. */
const Byline = ({ content }: { content: Content }) =>
  content.__typename === "Post" ? (
    <Typography variant="muted">
      {content.author?.node.name}
      {content.date && ` · ${formatDate(content.date)}`}
    </Typography>
  ) : null;

/** The title and byline, for content without a hero. */
const Header = ({ content }: { content: Content }) => (
  <Section as="header" paddingBottom="sm" paddingTop="lg">
    <Container>
      <div className="flex max-w-3xl flex-col gap-5">
        <Typography variant="h1">
          {"title" in content ? content.title : null}
        </Typography>
        <Byline content={content} />
      </div>
    </Container>
  </Section>
);

/** The block editor's HTML, under the header, hero or sections. */
const Body = ({ html, top }: { html: string; top: "none" | "md" }) => (
  <Section as="div" paddingBottom="lg" paddingTop={top}>
    <Container>
      <RichText className="max-w-3xl">
        <div
          className="l-rich-raw"
          // oxlint-disable-next-line react/no-danger -- block editor HTML, written by signed-in editors (see docs/spikes/03-cms-neutral-sections.md).
          dangerouslySetInnerHTML={{ __html: withMediaImages(html) }}
        />
      </RichText>
    </Container>
  </Section>
);

/**
 * Renders a page or post from WordPress. A hero and a page's Page Builder
 * sections render through @launch/ui, where the hero (or else the first
 * section's heading) is the <h1>; without a hero, the title is. A post's
 * byline and any block editor HTML follow, so content that has a hero but no
 * sections keeps its body.
 */
export const ContentView = ({ content }: { content: Content }) => {
  const page = toSectionsPage(content);
  const html = "content" in content ? content.content : null;
  const hasSections = Boolean(page?.sections.length);

  return (
    <article>
      {page ? <PageSections page={page} /> : <Header content={content} />}
      {page?.hero && content.__typename === "Post" && (
        <Section as="div" paddingBottom="none" paddingTop="sm">
          <Container>
            <Byline content={content} />
          </Container>
        </Section>
      )}
      {html && !hasSections && (
        <Body html={html} top={page?.hero ? "md" : "none"} />
      )}
    </article>
  );
};
