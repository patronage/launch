import type {
  Block,
  Image,
  Link,
  LinkVariant,
  Media,
  Page,
  Section,
  SectionOptions,
} from "@launch/content-model";
import {
  compact,
  oneOf,
  slugify,
  toColumns,
  toSkin,
  toSpacing,
  toWidth,
} from "@launch/content-model";
import type { ReactNode } from "react";

import { isPopulatedPage, renderLexical } from "./lexical";
import type {
  LayoutBlock,
  LexicalState,
  PayloadLink,
  PayloadMedia,
  PayloadPage,
  PayloadPageRef,
  PayloadReference,
  PayloadSectionOptions,
  PayloadUpload,
  UnknownBlock,
} from "./types";

export { renderLexical } from "./lexical";

export type * from "./types";

export interface PayloadAdapterOptions {
  /**
   * Origin that Payload's relative media URLs (`/api/media/file/…`) resolve
   * against. Leave unset when uploads already return absolute URLs.
   */
  serverUrl?: string;
  /** Rewrites image URLs, e.g. to an image CDN. Runs after `serverUrl`. */
  imageUrl?: (src: string) => string;
  /** Slug of the page served at `/`. */
  homeSlug?: string;
  /** Replaces the built-in Lexical renderer, e.g. with Payload's own `RichText`. */
  renderRichText?: (state: LexicalState) => ReactNode | undefined;
}

/** Payload's link `appearance` values from the website template, mapped to ours. */
const APPEARANCE = {
  default: "primary",
  link: "text",
  outline: "secondary",
  primary: "primary",
  secondary: "secondary",
  text: "text",
} as const satisfies Record<string, LinkVariant>;

const appearanceVariant = (
  appearance: string | null | undefined
): LinkVariant =>
  Object.entries(APPEARANCE).find(([key]) => key === appearance)?.[1] ??
  "primary";

/** True when an upload field holds the populated doc rather than its id (depth 0). */
const isPopulatedMedia = (upload: PayloadUpload): upload is PayloadMedia =>
  upload instanceof Object;

const KNOWN_BLOCKS = new Set<string>([
  "content",
  "contentMedia",
  "mediaBlock",
  "cardGrid",
  "blockquote",
  "cta",
]);

const isKnownBlock = (
  block: LayoutBlock | UnknownBlock
): block is LayoutBlock => KNOWN_BLOCKS.has(block.blockType);

const sectionOptions = (
  value: PayloadSectionOptions | null | undefined
): SectionOptions =>
  compact({
    hidden: value?.hidden === true,
    paddingBottom: toSpacing(value?.paddingBottom),
    paddingTop: toSpacing(value?.paddingTop),
    skin: toSkin(value?.skin),
    slug: slugify(value?.anchor),
    width: toWidth(value?.width),
  });

export const createPayloadAdapter = (options: PayloadAdapterOptions = {}) => {
  const serverUrl = options.serverUrl?.replace(/\/+$/u, "") ?? "";
  const imageUrl = options.imageUrl ?? ((src: string) => src);
  const homeSlug = options.homeSlug ?? "home";

  /** Path for a page doc: the last nested-docs breadcrumb, else `/slug`. */
  const pagePath = (doc: PayloadPageRef | PayloadPage): string | undefined => {
    const crumb = doc.breadcrumbs?.at(-1)?.url;

    if (crumb) {
      return crumb === `/${homeSlug}` ? "/" : crumb;
    }

    if (!doc.slug) {
      return undefined;
    }

    return doc.slug === homeSlug ? "/" : `/${doc.slug}`;
  };

  const resolveDoc = (ref: PayloadReference): string | undefined =>
    // At depth 0 the value is only an id; there is no path to build without another query.
    isPopulatedPage(ref.value) ? pagePath(ref.value) : undefined;

  const renderRichText =
    options.renderRichText ??
    ((state: LexicalState) => renderLexical(state, { resolveDoc }));

  const richText = (
    state: LexicalState | null | undefined
  ): ReactNode | undefined => (state ? renderRichText(state) : undefined);

  const link = (
    value: PayloadLink | null | undefined,
    variant?: LinkVariant
  ): Link | undefined => {
    if (!value?.label) {
      return undefined;
    }

    const href =
      value.type === "reference" && value.reference
        ? resolveDoc(value.reference)
        : (value.url ?? undefined);

    if (!href) {
      return undefined;
    }

    return {
      href,
      label: value.label,
      newTab: value.newTab === true,
      variant: variant ?? appearanceVariant(value.appearance),
    };
  };

  const links = (rows: { link: PayloadLink }[] | null | undefined): Link[] =>
    (rows ?? []).flatMap((row) => link(row.link) ?? []);

  const image = (upload: PayloadUpload): Image | undefined => {
    if (!(isPopulatedMedia(upload) && upload.url)) {
      return undefined;
    }

    const src = upload.url.startsWith("/")
      ? `${serverUrl}${upload.url}`
      : upload.url;

    return compact({
      alt: upload.alt ?? "",
      height: upload.height ?? undefined,
      src: imageUrl(src),
      width: upload.width ?? undefined,
    });
  };

  const media = (upload: PayloadUpload): Media | undefined => {
    const img = image(upload);

    if (!(img && isPopulatedMedia(upload))) {
      return undefined;
    }

    return compact({
      caption: upload.caption?.trim() || undefined,
      image: img,
    });
  };

  const block = (
    value: LayoutBlock,
    id: string
  ): Block<ReactNode> | undefined => {
    switch (value.blockType) {
      case "content": {
        return compact({
          align: oneOf(["start", "center"] as const, value.align, "start"),
          body: richText(value.richText),
          eyebrow: value.eyebrow ?? undefined,
          heading: value.heading ?? undefined,
          id,
          links: links(value.links),
          type: "content",
        });
      }

      case "contentMedia": {
        const m = media(value.media);

        if (!m) {
          return undefined;
        }

        return compact({
          body: richText(value.richText),
          eyebrow: value.eyebrow ?? undefined,
          heading: value.heading ?? undefined,
          id,
          links: links(value.links),
          media: m,
          mediaPosition: oneOf(
            ["start", "end"] as const,
            value.mediaPosition,
            "end"
          ),
          type: "contentMedia",
        });
      }

      case "mediaBlock": {
        const m = media(value.media);

        return m ? { id, media: m, type: "media" } : undefined;
      }

      case "cardGrid": {
        return compact({
          cards: (value.cards ?? []).flatMap((card, index) =>
            card.title
              ? [
                  compact({
                    id: card.id ?? `${id}-card-${index}`,
                    image: image(card.image),
                    link: card.enableLink ? link(card.link, "text") : undefined,
                    text: card.text ?? undefined,
                    title: card.title,
                  }),
                ]
              : []
          ),
          columns: toColumns(value.columns),
          heading: value.heading ?? undefined,
          id,
          type: "cardGrid",
        });
      }

      case "blockquote": {
        if (!value.quote) {
          return undefined;
        }

        return compact({
          attribution: value.attribution ?? undefined,
          id,
          image: image(value.image),
          quote: value.quote,
          role: value.role ?? undefined,
          type: "blockquote",
        });
      }

      case "cta": {
        if (!value.heading) {
          return undefined;
        }

        return compact({
          body: richText(value.richText),
          heading: value.heading,
          id,
          links: links(value.links),
          type: "callToAction",
        });
      }

      default: {
        return undefined;
      }
    }
  };

  const toPage = (doc: PayloadPage): Page<ReactNode> => {
    const sections: Section<ReactNode>[] = [];

    for (const [index, value] of (doc.layout ?? []).entries()) {
      const id = value.id ?? `${value.blockType}-${index}`;
      const mapped = isKnownBlock(value) ? block(value, id) : undefined;

      if (mapped) {
        sections.push({
          block: mapped,
          options: sectionOptions(value.sectionOptions),
        });
      }
    }

    return { path: pagePath(doc) ?? "/", sections, title: doc.title ?? "" };
  };

  return { pagePath, toPage };
};
