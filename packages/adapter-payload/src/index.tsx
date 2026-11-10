import type {
  Block,
  Form,
  Hero,
  HeroVariant,
  FormField,
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

import { isPopulatedPage, renderLexical } from "./lexical";
import type {
  LayoutBlock,
  LexicalState,
  FormBlock as PayloadFormBlock,
  PayloadForm,
  PayloadFormField,
  PayloadHero,
  PayloadLink,
  PayloadMedia,
  PayloadPage,
  PayloadPageRef,
  PayloadReference,
  PayloadRichTextBlock,
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
  /**
   * A `srcset` for an image, given its URL after `imageUrl` and its original
   * width, e.g. @launch/images' `imageSrcset`. Without it, images have none.
   */
  imageSrcset?: (src: string, width?: number) => string | undefined;
  /** Slug of the page served at `/`. */
  homeSlug?: string;
  /** Replaces the built-in Lexical renderer, e.g. with Payload's own `RichText`. */
  renderRichText?: (state: LexicalState) => ReactNode | undefined;
  /** Where form sections post their submissions. */
  formAction?: string;
  /**
   * Draws a block placed in rich text, e.g. with @launch/ui's `RichTextBlock`.
   * Without it, the built-in renderer leaves blocks out.
   */
  renderRichTextBlock?: (block: RichTextBlock) => ReactNode;
}

type HeroField = "body" | "image" | "subhead";

/** The optional fields each hero variant draws, as the admin shows them. */
const HERO_FIELDS = {
  freeform: ["body"],
  home: ["subhead", "image"],
  media: ["subhead", "image"],
  simple: ["subhead"],
  split: ["subhead", "image"],
} satisfies Record<HeroVariant, HeroField[]>;

/** True when a form relationship holds the populated doc rather than its id. */
const isPopulatedForm = (
  value: PayloadForm | number | string | null | undefined
): value is PayloadForm => value instanceof Object;

const toFieldType = (
  blockType: string
): FormField<ReactNode>["type"] | undefined =>
  FORM_FIELD_TYPES.find((type) => type === blockType);

/** True when an upload field holds the populated doc rather than its id (depth 0). */
const isPopulatedMedia = (upload: PayloadUpload): upload is PayloadMedia =>
  upload instanceof Object;

const KNOWN_BLOCKS = new Set<string>([
  "content",
  "contentMedia",
  "media",
  "cardGrid",
  "blockquote",
  "callToAction",
  "form",
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

  /** An image's URL and the srcset for it, from its original URL and width. */
  const imageSource = (original: string, width?: number) => {
    const src = imageUrl(original);

    return { src, srcset: options.imageSrcset?.(src, width) };
  };

  const homeSlug = options.homeSlug ?? "home";
  const formAction = options.formAction ?? "/forms/submit";

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
      variant: variant ?? toLinkVariant(value.variant),
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
      ...imageSource(src, upload.width ?? undefined),
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

  /** A rich-text block as the content model's, or undefined when incomplete. */
  const richTextBlock = (
    block: PayloadRichTextBlock
  ): RichTextBlock | undefined => {
    switch (block.blockType) {
      case "button": {
        const target = link(block.link);

        return target && { link: target, type: "button" };
      }

      case "image": {
        const found = media(block.image);

        return (
          found && {
            media: compact({
              ...found,
              caption: block.caption?.trim() || found.caption,
            }),
            type: "image",
          }
        );
      }

      case "pullquote": {
        return block.quote
          ? compact({
              attribution: block.attribution ?? undefined,
              quote: block.quote,
              type: "pullquote",
            })
          : undefined;
      }

      case "embed": {
        return block.url
          ? compact({
              caption: block.caption?.trim() || undefined,
              type: "embed",
              url: block.url,
            })
          : undefined;
      }

      default: {
        // Blocks this adapter does not know are left out.
        return undefined;
      }
    }
  };

  const renderBlock = (block: PayloadRichTextBlock): ReactNode => {
    const found = richTextBlock(block);

    return found && options.renderRichTextBlock?.(found);
  };

  const renderRichText =
    options.renderRichText ??
    ((state: LexicalState) =>
      renderLexical(state, { renderBlock, resolveDoc }));

  const richText = (
    state: LexicalState | null | undefined
  ): ReactNode | undefined => (state ? renderRichText(state) : undefined);

  /** A form-builder field, or undefined for types the UI does not draw. */
  const formField = (
    field: PayloadFormField
  ): FormField<ReactNode> | undefined => {
    const type = toFieldType(field.blockType);

    if (!type || (type !== "message" && !field.name)) {
      return undefined;
    }

    const defaultValue =
      field.defaultValue === null || field.defaultValue === undefined
        ? undefined
        : String(field.defaultValue);

    return compact({
      defaultValue,
      label: field.label ?? undefined,
      message: type === "message" ? richText(field.message) : undefined,
      name: field.name ?? "",
      options:
        type === "select"
          ? (field.options ?? []).flatMap((option) =>
              option.value
                ? [{ label: option.label ?? option.value, value: option.value }]
                : []
            )
          : undefined,
      required: field.required === true,
      type,
      width: field.width ?? undefined,
    });
  };

  const form = (value: PayloadForm): Form<ReactNode> =>
    compact({
      action: formAction,
      // Redirect confirmations are not drawn yet; they fall back to the default.
      confirmation:
        value.confirmationType === "message"
          ? richText(value.confirmationMessage)
          : undefined,
      fields: (value.fields ?? []).flatMap((field) => {
        const mapped = formField(field);

        return mapped ? [mapped] : [];
      }),
      id: String(value.id),
      submitLabel: value.submitButtonLabel || "Submit",
    });

  /** A form section, or undefined when its form was not populated. */
  const formBlock = (
    value: PayloadFormBlock,
    id: string
  ): Block<ReactNode> | undefined =>
    isPopulatedForm(value.form)
      ? compact({
          body: richText(value.body),
          form: form(value.form),
          heading: value.heading ?? undefined,
          id,
          type: "form",
        })
      : undefined;

  const block = (
    value: LayoutBlock,
    id: string
  ): Block<ReactNode> | undefined => {
    switch (value.blockType) {
      case "content": {
        return compact({
          align: oneOf(["start", "center"] as const, value.align, "start"),
          body: richText(value.body),
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
          body: richText(value.body),
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

      case "media": {
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
                    // Cards style their link as text; a link without a label is no link.
                    link: link(card.link, "text"),
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

      case "callToAction": {
        if (!value.heading) {
          return undefined;
        }

        return compact({
          body: richText(value.body),
          heading: value.heading,
          id,
          links: links(value.links),
          type: "callToAction",
        });
      }

      case "form": {
        return formBlock(value, id);
      }

      default: {
        return undefined;
      }
    }
  };

  /** The page's hero, or undefined when it has no variant. */
  const hero = (
    value: PayloadHero | null | undefined,
    pageTitle: string
  ): Hero<ReactNode> | undefined => {
    const variant = toHeroVariant(value?.variant);

    if (!(value && variant)) {
      return undefined;
    }

    // Each variant draws only its own fields; the rest may linger from another.
    const draws = (field: HeroField) =>
      HERO_FIELDS[variant].some((drawn) => drawn === field);

    return compact({
      align: oneOf(["start", "center"] as const, value.align, "start"),
      body: draws("body") ? richText(value.body) : undefined,
      eyebrow: value.eyebrow ?? undefined,
      image: draws("image") ? image(value.image) : undefined,
      links: links(value.links),
      skin: toSkin(value.skin),
      subhead: draws("subhead") ? (value.subhead ?? undefined) : undefined,
      title: value.title?.trim() || pageTitle,
      variant,
    });
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

    const title = doc.title ?? "";

    return compact({
      hero: hero(doc.hero, title),
      path: pagePath(doc) ?? "/",
      sections,
      title,
    });
  };

  return { pagePath, richTextBlock, toPage };
};
