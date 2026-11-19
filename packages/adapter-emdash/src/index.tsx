import type {
  Block,
  Hero,
  HeroVariant,
  Image,
  Link,
  LinkVariant,
  Media,
  Page,
  RichTextBlock,
  Section,
  SectionOptions,
} from "@launch/content-model";
import {
  compact,
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

import { renderPortableText } from "./portable-text";
import type {
  EmDashEntry,
  EmDashImage,
  EmDashLink,
  EmDashPageData,
  EmDashSection,
  EmDashSectionOptions,
  EmDashUnknownSection,
  PortableText,
  PortableTextImage,
} from "./types";

export { hasPortableText, renderPortableText } from "./portable-text";

export type * from "./types";

export interface EmDashAdapterOptions {
  /**
   * EmDash's origin. Media in R2 resolve to `{serverUrl}/_emdash/api/media/file/{key}`.
   */
  serverUrl?: string;
  /** Rewrites image URLs, e.g. to an image CDN or a resizing route. Runs after `serverUrl`. */
  imageUrl?: (src: string) => string;
  /**
   * A `srcset` for an image, given its URL after `imageUrl` and its original
   * width, e.g. @patronage/images' `imageSrcset`. Without it, images have none.
   */
  imageSrcset?: (src: string, width?: number) => string | undefined;
  /** Slug of the page served at `/`. */
  homeSlug?: string;
  /**
   * Draws a block placed in rich text, e.g. with @launch/ui's `RichTextBlock`.
   * EmDash's editor places images; without this, they are left out.
   */
  renderRichTextBlock?: (block: RichTextBlock) => ReactNode;
}

type HeroField = "body" | "image" | "subhead";

/** The optional fields each hero variant draws. */
const HERO_FIELDS = {
  freeform: ["body"],
  home: ["subhead", "image"],
  media: ["subhead", "image"],
  simple: ["subhead"],
  split: ["subhead", "image"],
} satisfies Record<HeroVariant, HeroField[]>;

const KNOWN_SECTIONS = new Set<string>([
  "content",
  "content_media",
  "media",
  "card_grid",
  "blockquote",
  "call_to_action",
]);

const isKnownSection = (
  value: EmDashSection | EmDashUnknownSection
): value is EmDashSection => KNOWN_SECTIONS.has(value._type);

/** A trimmed string, or undefined when empty. */
const text = (value: string | null | undefined): string | undefined =>
  value?.trim() || undefined;

/** A section's options in the content model, for sections an app draws itself. */
export const sectionOptions = (value: EmDashSectionOptions): SectionOptions =>
  compact({
    hidden: value.section_hidden === true,
    paddingBottom: toSpacing(value.section_padding_bottom),
    paddingTop: toSpacing(value.section_padding_top),
    skin: toSkin(value.section_skin),
    slug: slugify(value.section_anchor),
    width: toWidth(value.section_width),
  });

const link = (
  value: { [K in keyof EmDashLink]?: EmDashLink[K] | undefined } | undefined,
  variant?: LinkVariant
): Link | undefined => {
  const label = text(value?.label);
  const href = text(value?.url);

  if (!(label && href)) {
    return undefined;
  }

  return {
    href,
    label,
    newTab: value?.new_tab === true,
    variant: variant ?? toLinkVariant(value?.variant),
  };
};

const links = (rows: EmDashLink[] | null | undefined): Link[] =>
  (rows ?? []).flatMap((row) => link(row) ?? []);

export const createEmDashAdapter = (options: EmDashAdapterOptions = {}) => {
  const serverUrl = options.serverUrl?.replace(/\/+$/u, "") ?? "";
  const imageUrl = options.imageUrl ?? ((src: string) => src);
  const homeSlug = options.homeSlug ?? "home";

  /** Site path for a page slug; the home page is `/`. */
  const pagePath = (slug: string | null | undefined): string =>
    !slug || slug === homeSlug ? "/" : `/${slug}`;

  /** An image's original URL: R2 media through EmDash's file route, else its own URL. */
  const mediaUrl = (value: {
    src?: string | undefined;
    url?: string | undefined;
    storageKey?: string | undefined;
  }): string | undefined => {
    if (value.storageKey) {
      return `${serverUrl}/_emdash/api/media/file/${encodeURIComponent(value.storageKey)}`;
    }

    const url = value.src ?? value.url;

    return url?.startsWith("/") ? `${serverUrl}${url}` : url;
  };

  const imageSource = (original: string, width?: number) => {
    const src = imageUrl(original);

    return { src, srcset: options.imageSrcset?.(src, width) };
  };

  const image = (value: EmDashImage | null | undefined): Image | undefined => {
    const original =
      value &&
      mediaUrl({
        src: value.src,
        storageKey: value.meta?.storageKey,
      });

    if (!(value && original)) {
      return undefined;
    }

    return compact({
      alt: value.alt ?? "",
      height: value.height,
      ...imageSource(original, value.width),
      width: value.width,
    });
  };

  const media = (
    value: EmDashImage | null | undefined,
    caption?: string
  ): Media | undefined => {
    const found = image(value);

    return found && compact({ caption: text(caption), image: found });
  };

  /** An image placed in rich text, as the content model's image embed. */
  const richTextImage = (
    value: PortableTextImage
  ): RichTextBlock | undefined => {
    const original = value.asset && mediaUrl(value.asset);

    if (!original) {
      return undefined;
    }

    return {
      media: compact({
        caption: text(value.caption),
        image: compact({
          alt: value.alt ?? "",
          height: value.height,
          ...imageSource(original, value.width),
          width: value.width,
        }),
      }),
      type: "image",
    };
  };

  const richText = (nodes: PortableText | undefined): ReactNode | undefined =>
    renderPortableText(nodes, {
      renderImage: (value) => {
        const found = richTextImage(value);

        return found && options.renderRichTextBlock?.(found);
      },
    });

  const block = (
    value: EmDashSection,
    id: string
  ): Block<ReactNode> | undefined => {
    switch (value._type) {
      case "content": {
        return compact({
          align: oneOf(["start", "center"] as const, value.align, "start"),
          body: richText(value.body),
          eyebrow: text(value.eyebrow),
          heading: text(value.heading),
          id,
          links: links(value.links),
          type: "content",
        });
      }

      case "content_media": {
        const found = media(value.image, value.caption);

        return (
          found &&
          compact({
            body: richText(value.body),
            eyebrow: text(value.eyebrow),
            heading: text(value.heading),
            id,
            links: links(value.links),
            media: found,
            mediaPosition: oneOf(
              ["start", "end"] as const,
              value.media_position,
              "end"
            ),
            type: "contentMedia",
          })
        );
      }

      case "media": {
        const found = media(value.image, value.caption);

        return found && { id, media: found, type: "media" };
      }

      case "card_grid": {
        return compact({
          cards: (value.cards ?? []).flatMap((card, index) => {
            const title = text(card.title);

            return title
              ? [
                  compact({
                    id: `${id}-card-${index}`,
                    image: image(card.image),
                    // Cards style their link as text.
                    link: link(
                      { label: card.link_label, url: card.link_url },
                      "text"
                    ),
                    text: text(card.text),
                    title,
                  }),
                ]
              : [];
          }),
          columns: toColumns(value.columns),
          heading: text(value.heading),
          id,
          type: "cardGrid",
        });
      }

      case "blockquote": {
        const quote = text(value.quote);

        return quote
          ? compact({
              attribution: text(value.attribution),
              id,
              image: image(value.image),
              quote,
              role: text(value.role),
              type: "blockquote",
            })
          : undefined;
      }

      case "call_to_action": {
        const heading = text(value.heading);

        return heading
          ? compact({
              body: richText(value.body),
              heading,
              id,
              links: links(value.links),
              type: "callToAction",
            })
          : undefined;
      }

      default: {
        return undefined;
      }
    }
  };

  /** The page's hero, or undefined for `none` or no variant. */
  const hero = (
    data: EmDashPageData,
    pageTitle: string
  ): Hero<ReactNode> | undefined => {
    const variant = toHeroVariant(data.hero_variant);

    if (!variant) {
      return undefined;
    }

    // Each variant draws only its own fields; the rest may linger from another.
    const draws = (field: HeroField) =>
      HERO_FIELDS[variant].some((drawn) => drawn === field);

    return compact({
      align: oneOf(["start", "center"] as const, data.hero_align, "start"),
      body: draws("body") ? richText(data.hero_body) : undefined,
      eyebrow: text(data.hero_eyebrow),
      image: draws("image") ? image(data.hero_image) : undefined,
      links: links(data.hero_links),
      skin: toSkin(data.hero_skin),
      subhead: draws("subhead") ? text(data.hero_subhead) : undefined,
      title: text(data.hero_title) ?? pageTitle,
      variant,
    });
  };

  /**
   * Maps a page entry. Pass the data to render as `data` when it differs from
   * `entry.data`, as with the published `liveData` of an entry with a draft.
   */
  const toPage = (
    entry: Pick<EmDashEntry, "slug" | "data">,
    data: EmDashPageData = entry.data
  ): Page<ReactNode> => {
    const sections: Section<ReactNode>[] = [];

    for (const [index, value] of (data.sections ?? []).entries()) {
      const id = value._key ?? `${value._type}-${index}`;
      const mapped = isKnownSection(value) ? block(value, id) : undefined;

      if (mapped) {
        sections.push({ block: mapped, options: sectionOptions(value) });
      }
    }

    const title = text(data.title) ?? "";

    return compact({
      hero: hero(data, title),
      path: pagePath(entry.slug),
      sections,
      title,
    });
  };

  return { pagePath, richTextImage, toPage };
};
