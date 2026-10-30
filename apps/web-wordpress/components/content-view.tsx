import {
  buttonVariants,
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

const Hero = ({ content }: { content: Content }) => {
  const title = "title" in content ? content.title : null;
  const hero = "hero" in content ? content.hero : null;

  return (
    <Section as="header" paddingBottom="sm" paddingTop="lg">
      <Container>
        <div className="flex max-w-3xl flex-col gap-5">
          {hero?.eyebrow && (
            <Typography variant="eyebrow">{hero.eyebrow}</Typography>
          )}
          <Typography variant="h1">{hero?.headline || title}</Typography>
          {hero?.intro && <Typography variant="lead">{hero.intro}</Typography>}
          {content.__typename === "Post" && (
            <Typography variant="muted">
              {content.author?.node.name}
              {content.date && ` · ${formatDate(content.date)}`}
            </Typography>
          )}
          {hero?.cta?.url && (
            <div className="mt-2">
              <a
                className={buttonVariants({ size: "lg" })}
                href={hero.cta.url}
                target={hero.cta.target || undefined}
              >
                {hero.cta.title || hero.cta.url}
              </a>
            </div>
          )}
        </div>
      </Container>
    </Section>
  );
};

/**
 * Renders a page or post from WordPress. Pages built with the Page Builder
 * render through @launch/ui, under the hero when the page has one; everything
 * else shows the hero and the block editor's HTML.
 */
export const ContentView = ({ content }: { content: Content }) => {
  const sections = toSectionsPage(content);
  const hasHero = "hero" in content && Boolean(content.hero?.headline);
  const html = "content" in content ? content.content : null;

  if (sections && !hasHero) {
    return <PageSections page={sections} />;
  }

  return (
    <article>
      <Hero content={content} />
      {sections ? (
        <PageSections firstHeadingIsTitle={false} page={sections} />
      ) : (
        html && (
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
        )
      )}
    </article>
  );
};
