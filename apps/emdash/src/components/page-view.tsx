import { createEmDashAdapter } from "@launch/adapter-emdash";
import type { EmDashPageData } from "@launch/adapter-emdash";
import { PageSections, RichTextBlock } from "@launch/ui";

const MEDIA_ROUTE = "/_emdash/api/media/file/";

// Media resolve to EmDash's /_emdash/api/media/file/{key}, which sits behind
// Access with the admin; src/pages/media serves the same files publicly.
export const adapter = createEmDashAdapter({
  imageUrl: (src) =>
    src.startsWith(MEDIA_ROUTE)
      ? `/media/${src.slice(MEDIA_ROUTE.length)}`
      : src,
  renderRichTextBlock: (block) => <RichTextBlock block={block} />,
});

interface Props {
  slug: string;
  data: EmDashPageData;
  /** False after the page's first run, whose hero or first heading is the title. */
  firstHeadingIsTitle?: boolean;
}

/** A page's hero and sections, through the shared content model. */
export const PageView = ({ slug, data, firstHeadingIsTitle }: Props) => (
  <PageSections
    firstHeadingIsTitle={firstHeadingIsTitle}
    page={adapter.toPage({ data, slug })}
  />
);
