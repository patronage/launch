import type { Content } from "@/lib/wordpress/content";

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString("en-US", { dateStyle: "long" });

/**
 * Renders a page or post from WordPress as it comes back from WPGraphQL.
 * Spike 2's adapter will map this to packages/content-model for packages/ui.
 */
export const ContentView = ({ content }: { content: Content }) => {
  const title = "title" in content ? content.title : null;
  const hero = "hero" in content ? content.hero : null;
  const html = "content" in content ? content.content : null;

  return (
    <article>
      <header>
        {hero?.eyebrow && <p className="hero-eyebrow">{hero.eyebrow}</p>}
        <h1>{hero?.headline || title}</h1>
        {hero?.intro && <p>{hero.intro}</p>}
        {hero?.cta?.url && (
          <p>
            <a href={hero.cta.url} target={hero.cta.target || undefined}>
              {hero.cta.title || hero.cta.url}
            </a>
          </p>
        )}
        {content.__typename === "Post" && (
          <p>
            {content.author?.node.name}
            {content.date && ` · ${formatDate(content.date)}`}
          </p>
        )}
      </header>
      {html && (
        // oxlint-disable-next-line react/no-danger -- block HTML rendered and sanitised by WordPress; Spike 2 decides how rich text reaches packages/ui.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </article>
  );
};
