import type {
  Block,
  Image,
  Link,
  Media,
  Page,
  Section,
  SectionOptions,
  SelectValue,
} from "@launch/content-model";
import {
  compact,
  oneOf,
  slugify,
  toColumns,
  toLinkVariant,
  toSkin,
  toSpacing,
  toWidth,
} from "@launch/content-model";
import type { ReactNode } from "react";

import type {
  AcfButton,
  AcfImage,
  AcfLink,
  AcfSectionOptions,
  Layout,
  PageQueryResult,
  UnknownLayout,
} from "./types";

export type * from "./types";

export interface WordPressAdapterOptions {
  /**
   * The WordPress origin, e.g. `https://cms.example.com`. Links and rich-text
   * hrefs on this origin become site-relative paths, because WordPress stores
   * internal links as absolute URLs on the CMS host.
   */
  cmsOrigin: string;
  /** Rewrites image URLs, e.g. to an image CDN. Defaults to the WordPress URL. */
  imageUrl?: (src: string) => string;
  /** Renders WordPress HTML. Defaults to `renderHtml`. */
  renderRichText?: (html: string) => ReactNode;
}

/**
 * Default rich-text renderer. It trusts the HTML, which only authenticated
 * editors can write; sanitize here if that ever changes.
 */
export const renderHtml = (html: string): ReactNode => (
  // oxlint-disable-next-line react/no-danger -- WordPress rich text is HTML by design; see docs/spikes.
  <div className="l-rich-raw" dangerouslySetInnerHTML={{ __html: html }} />
);

const KNOWN_LAYOUTS = new Set<string>([
  "PageBuilderSectionsContentLayout",
  "PageBuilderSectionsContentMediaLayout",
  "PageBuilderSectionsMediaLayout",
  "PageBuilderSectionsCardGridLayout",
  "PageBuilderSectionsBlockquoteLayout",
  "PageBuilderSectionsCallToActionLayout",
]);

const isKnownLayout = (layout: Layout | UnknownLayout): layout is Layout =>
  KNOWN_LAYOUTS.has(layout.__typename);

const layoutName = (typename: string): string =>
  slugify(typename.replaceAll(/^PageBuilderSections|Layout$/gu, "")) ??
  "layout";

const stripTags = (html: string | null | undefined): string | undefined => {
  const text = html
    ?.replaceAll(/<[^>]*>/gu, "")
    .replaceAll("&amp;", "&")
    .trim();

  return text || undefined;
};

const sectionOptions = (
  acf: AcfSectionOptions | null | undefined
): SectionOptions =>
  compact({
    hidden: acf?.hide === true,
    paddingBottom: toSpacing(acf?.paddingBottom),
    paddingTop: toSpacing(acf?.paddingTop),
    skin: toSkin(acf?.background),
    slug: slugify(acf?.anchor),
    width: toWidth(acf?.containerWidth),
  });

export const createWordPressAdapter = (options: WordPressAdapterOptions) => {
  const origin = options.cmsOrigin.replace(/\/+$/u, "");
  const imageUrl = options.imageUrl ?? ((src: string) => src);
  const renderRichText = options.renderRichText ?? renderHtml;

  /** Makes CMS-origin URLs site-relative and drops WordPress's trailing slash. */
  const localizeUrl = (url: string): string => {
    if (url !== origin && !url.startsWith(`${origin}/`)) {
      return url;
    }

    const path = url.slice(origin.length) || "/";

    return path.length > 1 ? path.replace(/\/(?=$|[?#])/u, "") : path;
  };

  const richText = (html: string | null | undefined): ReactNode | undefined => {
    const trimmed = html?.trim();

    if (!trimmed) {
      return undefined;
    }

    const localized = trimmed.replaceAll(
      /href="(?<href>[^"]*)"/gu,
      (_match, href: string) => `href="${localizeUrl(href)}"`
    );

    return renderRichText(localized);
  };

  const link = (
    acf: AcfLink | null | undefined,
    style?: SelectValue
  ): Link | undefined => {
    if (!(acf?.url && acf.title)) {
      return undefined;
    }

    return {
      href: localizeUrl(acf.url),
      label: acf.title,
      newTab: acf.target === "_blank",
      // Card links have no style field and render as text links.
      variant: style === undefined ? "text" : toLinkVariant(style),
    };
  };

  const buttons = (rows: AcfButton[] | null | undefined): Link[] =>
    (rows ?? []).flatMap((row) => link(row.link, row.style) ?? []);

  const image = (acf: AcfImage | null | undefined): Image | undefined => {
    const node = acf?.node;

    if (!node?.sourceUrl) {
      return undefined;
    }

    return compact({
      alt: node.altText ?? "",
      height: node.mediaDetails?.height ?? undefined,
      src: imageUrl(node.sourceUrl),
      width: node.mediaDetails?.width ?? undefined,
    });
  };

  const media = (acf: AcfImage | null | undefined): Media | undefined => {
    const img = image(acf);

    if (!img) {
      return undefined;
    }

    // Captions come back as HTML; the shared model keeps them as plain text.
    return compact({ caption: stripTags(acf?.node?.caption), image: img });
  };

  const block = (layout: Layout, id: string): Block<ReactNode> | undefined => {
    switch (layout.__typename) {
      case "PageBuilderSectionsContentLayout": {
        return compact({
          align: oneOf(["start", "center"] as const, layout.alignment, "start"),
          body: richText(layout.content),
          eyebrow: layout.eyebrow ?? undefined,
          heading: layout.heading ?? undefined,
          id,
          links: buttons(layout.buttons),
          type: "content",
        });
      }

      case "PageBuilderSectionsContentMediaLayout": {
        const m = media(layout.image);

        if (!m) {
          return undefined;
        }

        return compact({
          body: richText(layout.content),
          eyebrow: layout.eyebrow ?? undefined,
          heading: layout.heading ?? undefined,
          id,
          links: buttons(layout.buttons),
          media: m,
          mediaPosition: oneOf(
            ["start", "end"] as const,
            layout.imagePosition,
            "end"
          ),
          type: "contentMedia",
        });
      }

      case "PageBuilderSectionsMediaLayout": {
        const m = media(layout.image);

        return m ? { id, media: m, type: "media" } : undefined;
      }

      case "PageBuilderSectionsCardGridLayout": {
        return compact({
          cards: (layout.cards ?? []).flatMap((card, index) =>
            card.title
              ? [
                  compact({
                    id: `${id}-card-${index}`,
                    image: image(card.image),
                    link: link(card.link),
                    text: card.text ?? undefined,
                    title: card.title,
                  }),
                ]
              : []
          ),
          columns: toColumns(layout.columns),
          heading: layout.heading ?? undefined,
          id,
          type: "cardGrid",
        });
      }

      case "PageBuilderSectionsBlockquoteLayout": {
        if (!layout.quote) {
          return undefined;
        }

        return compact({
          attribution: layout.attribution ?? undefined,
          id,
          image: image(layout.image),
          quote: layout.quote,
          role: layout.role ?? undefined,
          type: "blockquote",
        });
      }

      case "PageBuilderSectionsCallToActionLayout": {
        if (!layout.heading) {
          return undefined;
        }

        return compact({
          body: richText(layout.content),
          heading: layout.heading,
          id,
          links: buttons(layout.buttons),
          type: "callToAction",
        });
      }

      default: {
        return undefined;
      }
    }
  };

  const toPage = (result: PageQueryResult): Page<ReactNode> | undefined => {
    const { page } = result.data;

    if (!page) {
      return undefined;
    }

    const sections: Section<ReactNode>[] = [];

    for (const [index, layout] of (
      page.pageBuilder?.sections ?? []
    ).entries()) {
      // ACF flexible content rows have no stable id, so the row index stands in.
      const mapped = isKnownLayout(layout)
        ? block(layout, `${layoutName(layout.__typename)}-${index}`)
        : undefined;

      if (mapped) {
        sections.push({
          block: mapped,
          options: sectionOptions(layout.sectionOptions),
        });
      }
    }

    return {
      path: localizeUrl(page.uri ?? "/"),
      sections,
      title: page.title ?? "",
    };
  };

  return { localizeUrl, toPage };
};
