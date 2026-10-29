import { PageSections } from "@launch/ui";

import type { Content } from "@/lib/wordpress/content";
import { toSectionsPage } from "@/lib/wordpress/sections";

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-US", { dateStyle: "long" });

const Hero = ({ content }: { content: Content }) => {
  const title = "title" in content ? content.title : null;
  const hero = "hero" in content ? content.hero : null;

  return (
    <header className="l-section" data-pb="sm" data-pt="lg" data-skin="light">
      <div className="l-container l-content" data-width="default">
        {hero?.eyebrow && <p className="l-eyebrow">{hero.eyebrow}</p>}
        <h1 className="l-display">{hero?.headline || title}</h1>
        {hero?.intro && <p className="l-lead">{hero.intro}</p>}
        {content.__typename === "Post" && (
          <p className="post-meta">
            {content.author?.node.name}
            {content.date && ` · ${formatDate(content.date)}`}
          </p>
        )}
        {hero?.cta?.url && (
          <ul className="l-links">
            <li>
              <a
                className="l-link"
                data-variant="primary"
                href={hero.cta.url}
                target={hero.cta.target || undefined}
              >
                {hero.cta.title || hero.cta.url}
              </a>
            </li>
          </ul>
        )}
      </div>
    </header>
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
          <div
            className="l-section"
            data-pb="lg"
            data-pt="sm"
            data-skin="light"
          >
            <div className="l-container" data-width="narrow">
              <div
                className="l-rich"
                // oxlint-disable-next-line react/no-danger -- block editor HTML, written by signed-in editors (see docs/spikes/03-cms-neutral-sections.md).
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          </div>
        )
      )}
    </article>
  );
};
