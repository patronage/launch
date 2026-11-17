import type {
  Block,
  Form,
  FormField,
  Hero,
  HeroVariant,
  Image,
  Link,
  Media,
  Page,
  RichTextBlock,
  Section,
  SectionOptions,
  SelectValue,
} from "@launch/content-model";
import {
  compact,
  FORM_FIELD_TYPES,
  oneOf,
  slugify,
  toColumns,
  toHeroVariant,
  toLinkVariant,
  toSkin,
  toSpacing,
  toWidth,
} from "@launch/content-model";
import type { ReactNode } from "react";

import {
  hasRichTextBlocks,
  renderHtmlWithBlocks,
  stripRichTextBlocks,
} from "./rich-text-blocks";
import type { WordPressRichTextBlock } from "./rich-text-blocks";
import type {
  AcfForm,
  AcfFormField,
  AcfHero,
  AcfLinkRow,
  AcfImage,
  AcfLink,
  AcfSectionOptions,
  Layout,
  PageQueryResult,
  UnknownLayout,
} from "./types";

export type * from "./types";

export type { WordPressRichTextBlock } from "./rich-text-blocks";

export interface WordPressAdapterOptions {
  /**
   * The WordPress origin, e.g. `https://cms.example.com`. Links and rich-text
   * hrefs on this origin become site-relative paths, because WordPress stores
   * internal links as absolute URLs on the CMS host.
   */
  cmsOrigin: string;
  /** Rewrites image URLs, e.g. to an image CDN. Defaults to the WordPress URL. */
  imageUrl?: (src: string) => string;
  /**
   * A `srcset` for an image, given its URL after `imageUrl` and its original
   * width, e.g. @launch/images' `imageSrcset`. Without it, images have none.
   */
  imageSrcset?: (src: string, width?: number) => string | undefined;
  /**
   * Rewrites a link to an uploaded file, e.g. a PDF, to where visitors can
   * reach it, such as @launch/images' media route. A URL it returns
   * unchanged is made site-relative like any other CMS link.
   */
  mediaUrl?: (url: string) => string;
  /**
   * Renders WordPress HTML. Defaults to `renderHtml`. Rich text holding
   * rich-text blocks is parsed into React instead when `renderRichTextBlock`
   * is set, since a block can sit inside a paragraph.
   */
  renderRichText?: (html: string) => ReactNode;
  /**
   * Draws a block placed in rich text, e.g. with @launch/ui's `RichTextBlock`.
   * Without it, blocks are left out.
   */
  renderRichTextBlock?: (block: RichTextBlock) => ReactNode;
  /** Where form sections post their submissions. */
  formAction?: string;
}

/**
 * Default rich-text renderer. It trusts the HTML: the fields plugin filters
 * rich-text fields with wp_kses_post() when they load
 * (wordpress-shared/patronage-fields/field-values.php) and WordPress filters
 * post content when it is saved. Sanitize here if HTML ever arrives from
 * anywhere else.
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
  "PageBuilderSectionsFormLayout",
]);

type HeroField = "body" | "image" | "subhead";

/** The optional fields each hero variant draws, as the admin shows them. */
const HERO_FIELDS = {
  freeform: ["body"],
  home: ["subhead", "image"],
  media: ["subhead", "image"],
  simple: ["subhead"],
  split: ["subhead", "image"],
} satisfies Record<HeroVariant, HeroField[]>;

const toFieldType = (type: string): FormField<ReactNode>["type"] | undefined =>
  FORM_FIELD_TYPES.find((known) => known === type);

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
    hidden: acf?.hidden === true,
    paddingBottom: toSpacing(acf?.paddingBottom),
    paddingTop: toSpacing(acf?.paddingTop),
    skin: toSkin(acf?.skin),
    slug: slugify(acf?.anchor),
    width: toWidth(acf?.width),
  });

export const createWordPressAdapter = (options: WordPressAdapterOptions) => {
  const origin = options.cmsOrigin.replace(/\/+$/u, "");
  const imageUrl = options.imageUrl ?? ((src: string) => src);

  /** An image's URL and the srcset for it, from its original URL and width. */
  const imageSource = (original: string, width?: number) => {
    const src = imageUrl(original);

    return { src, srcset: options.imageSrcset?.(src, width) };
  };

  const renderRichText = options.renderRichText ?? renderHtml;
  const formAction = options.formAction ?? "/forms/submit";

  /**
   * Points links to uploaded files at `mediaUrl`, and makes other CMS-origin
   * URLs site-relative without WordPress's trailing slash.
   */
  const localizeUrl = (url: string): string => {
    const media = options.mediaUrl?.(url);

    if (media !== undefined && media !== url) {
      return media;
    }

    if (url !== origin && !url.startsWith(`${origin}/`)) {
      return url;
    }

    const path = url.slice(origin.length) || "/";

    return path.length > 1 ? path.replace(/\/(?=$|[?#])/u, "") : path;
  };

  /** A rich-text block as the content model's, with the site's URLs. */
  const richTextBlock = (block: WordPressRichTextBlock): RichTextBlock => {
    switch (block.type) {
      case "button": {
        return {
          link: {
            href: localizeUrl(block.link.href),
            label: block.link.label,
            newTab: block.link.newTab,
            variant: toLinkVariant(block.link.variant),
          },
          type: "button",
        };
      }

      case "image": {
        const { caption, image: img } = block.media;

        return {
          media: compact({
            caption,
            image: compact({ ...img, ...imageSource(img.src, img.width) }),
          }),
          type: "image",
        };
      }

      default: {
        return compact(block);
      }
    }
  };

  const renderBlock = (block: WordPressRichTextBlock): ReactNode =>
    options.renderRichTextBlock?.(richTextBlock(block));

  const richText = (html: string | null | undefined): ReactNode | undefined => {
    const trimmed = html?.trim();

    if (!trimmed) {
      return undefined;
    }

    const localized = trimmed.replaceAll(
      /href="(?<href>[^"]*)"/gu,
      (_match, href: string) => `href="${localizeUrl(href)}"`
    );

    if (!hasRichTextBlocks(localized)) {
      return renderRichText(localized);
    }

    if (options.renderRichTextBlock) {
      return renderHtmlWithBlocks(localized, renderBlock);
    }

    const stripped = stripRichTextBlocks(localized).trim();

    return stripped ? renderRichText(stripped) : undefined;
  };

  const link = (
    acf: AcfLink | null | undefined,
    variant?: SelectValue
  ): Link | undefined => {
    if (!(acf?.url && acf.title)) {
      return undefined;
    }

    return {
      href: localizeUrl(acf.url),
      label: acf.title,
      newTab: acf.target === "_blank",
      // Card links have no variant field and render as text links.
      variant: variant === undefined ? "text" : toLinkVariant(variant),
    };
  };

  const links = (
    rows: readonly (AcfLinkRow | null)[] | null | undefined
  ): Link[] =>
    (rows ?? []).flatMap((row) => link(row?.link, row?.variant) ?? []);

  const image = (acf: AcfImage | null | undefined): Image | undefined => {
    const node = acf?.node;

    if (!node?.sourceUrl) {
      return undefined;
    }

    return compact({
      alt: node.altText ?? "",
      height: node.mediaDetails?.height ?? undefined,
      ...imageSource(node.sourceUrl, node.mediaDetails?.width ?? undefined),
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

  /** A form field, or undefined for types the UI does not draw. */
  const formField = (field: AcfFormField): FormField<ReactNode> | undefined => {
    const type = toFieldType(field.type);

    if (!type || (type !== "message" && !field.name)) {
      return undefined;
    }

    return compact({
      defaultValue: field.defaultValue ?? undefined,
      label: field.label ?? undefined,
      message: type === "message" ? richText(field.message) : undefined,
      name: field.name,
      options:
        type === "select"
          ? (field.options ?? []).map((option) => ({
              label: option.label,
              value: option.value,
            }))
          : undefined,
      required: field.required,
      type,
      width: field.width ?? undefined,
    });
  };

  const form = (value: AcfForm): Form<ReactNode> =>
    compact({
      action: formAction,
      confirmation: richText(value.confirmation),
      fields: value.fields.flatMap((field) => formField(field) ?? []),
      id: value.id,
      submitLabel: value.submitLabel || "Submit",
    });

  /** A form section, or undefined when its form is missing or unpublished. */
  const formBlock = (
    layout: Extract<Layout, { __typename: "PageBuilderSectionsFormLayout" }>,
    id: string
  ): Block<ReactNode> | undefined =>
    layout.form
      ? compact({
          body: richText(layout.body),
          form: form(layout.form),
          heading: layout.heading || undefined,
          id,
          type: "form",
        })
      : undefined;

  /** The page's hero, or undefined when it has no variant. */
  const hero = (
    value: AcfHero | null | undefined,
    pageTitle: string
  ): Hero<ReactNode> | undefined => {
    const variant = toHeroVariant(value?.variant?.flatMap((v) => v ?? []));

    if (!(value && variant)) {
      return undefined;
    }

    // Each variant draws only its own fields; the rest may linger from another.
    const draws = (field: HeroField) =>
      HERO_FIELDS[variant].some((drawn) => drawn === field);

    return compact({
      align: oneOf(["start", "center"] as const, value.align, "start"),
      body: draws("body") ? richText(value.body) : undefined,
      eyebrow: value.eyebrow || undefined,
      image: draws("image") ? image(value.image) : undefined,
      links: links(value.links),
      skin: toSkin(value.skin),
      subhead: draws("subhead") ? value.subhead || undefined : undefined,
      title: value.title?.trim() || pageTitle,
      variant,
    });
  };

  const block = (layout: Layout, id: string): Block<ReactNode> | undefined => {
    switch (layout.__typename) {
      case "PageBuilderSectionsContentLayout": {
        return compact({
          align: oneOf(["start", "center"] as const, layout.align, "start"),
          body: richText(layout.body),
          eyebrow: layout.eyebrow ?? undefined,
          heading: layout.heading ?? undefined,
          id,
          links: links(layout.links),
          type: "content",
        });
      }

      case "PageBuilderSectionsContentMediaLayout": {
        const m = media(layout.media);

        if (!m) {
          return undefined;
        }

        return compact({
          body: richText(layout.body),
          eyebrow: layout.eyebrow ?? undefined,
          heading: layout.heading ?? undefined,
          id,
          links: links(layout.links),
          media: m,
          mediaPosition: oneOf(
            ["start", "end"] as const,
            layout.mediaPosition,
            "end"
          ),
          type: "contentMedia",
        });
      }

      case "PageBuilderSectionsMediaLayout": {
        const m = media(layout.media);

        return m ? { id, media: m, type: "media" } : undefined;
      }

      case "PageBuilderSectionsCardGridLayout": {
        return compact({
          cards: (layout.cards ?? []).flatMap((card, index) =>
            card?.title
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
          body: richText(layout.body),
          heading: layout.heading,
          id,
          links: links(layout.links),
          type: "callToAction",
        });
      }

      case "PageBuilderSectionsFormLayout": {
        return formBlock(layout, id);
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
      const mapped =
        layout && isKnownLayout(layout)
          ? block(layout, `${layoutName(layout.__typename)}-${index}`)
          : undefined;

      if (layout && mapped) {
        sections.push({
          block: mapped,
          options: sectionOptions(layout.sectionOptions),
        });
      }
    }

    const title = page.title ?? "";

    return compact({
      hero: hero(page.hero, title),
      // WPGraphQL gives the URI as a path; make it a CMS URL to localize it.
      path: localizeUrl(`${origin}${page.uri ?? "/"}`),
      sections,
      title,
    });
  };

  return { localizeUrl, richTextBlock, toPage };
};
