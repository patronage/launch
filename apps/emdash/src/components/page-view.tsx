import { createEmDashAdapter } from "@launch/adapter-emdash";
import type { EmDashPageData } from "@launch/adapter-emdash";
import { PageSections, RichTextBlock } from "@launch/ui";

const MEDIA_ROUTE = "/_emdash/api/media/file/";

// Media resolve to EmDash's /_emdash/api/media/file/{key}, which sits behind
// Access with the admin; src/pages/media serves the same files publicly.
const adapter = createEmDashAdapter({
  imageUrl: (src) =>
    src.startsWith(MEDIA_ROUTE)
      ? `/media/${src.slice(MEDIA_ROUTE.length)}`
      : src,
  renderRichTextBlock: (block) => <RichTextBlock block={block} />,
});

interface Props {
  slug: string;
  data: EmDashPageData;
}

/** A page's hero and sections, through the shared content model. */
export const PageView = ({ slug, data }: Props) => (
  <PageSections page={adapter.toPage({ data, slug })} />
);
