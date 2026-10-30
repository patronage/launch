/**
 * CMS-neutral content model for page sections.
 *
 * Every CMS adapter maps its own data into these types. Rich text is the one
 * thing that is not modelled here: each adapter renders its own rich text
 * format and passes the result in as `R` (a React node in practice). That keeps
 * this package free of any framework or CMS dependency.
 */

/** Colour treatment for a section. Maps to `data-skin` in the UI tokens. */
export const SKINS = ["light", "dark", "accent"] as const;

export type Skin = (typeof SKINS)[number];

/** Maximum content width inside a section. */
export const CONTAINER_WIDTHS = ["narrow", "default", "wide", "full"] as const;

export type ContainerWidth = (typeof CONTAINER_WIDTHS)[number];

/** Vertical padding step. */
export const SPACINGS = ["none", "sm", "md", "lg"] as const;

export type Spacing = (typeof SPACINGS)[number];

export interface SectionOptions {
  skin: Skin;
  width: ContainerWidth;
  paddingTop: Spacing;
  paddingBottom: Spacing;
  /** Hidden sections are dropped by `visibleSections`, not rendered as `display: none`. */
  hidden: boolean;
  /** Anchor id for in-page links, already slugified. */
  slug?: string;
}

export const DEFAULT_SECTION_OPTIONS: SectionOptions = {
  hidden: false,
  paddingBottom: "md",
  paddingTop: "md",
  skin: "light",
  width: "default",
};

export const LINK_VARIANTS = ["primary", "secondary", "text"] as const;

export type LinkVariant = (typeof LINK_VARIANTS)[number];

export interface Link {
  label: string;
  /** Site-relative path (`/about`) for internal links, absolute URL for external ones. */
  href: string;
  newTab: boolean;
  variant: LinkVariant;
}

export interface Image {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface Media {
  image: Image;
  /** Plain-text caption. */
  caption?: string;
}

// Rich-text blocks -----------------------------------------------------------

/**
 * Blocks an editor can place inside rich text. The adapter maps them from its
 * CMS and hands each to the app, which draws it with @launch/ui's
 * `RichTextBlock`; the rest of the rich text stays the adapter's own `R`.
 */

/** A button between or inside paragraphs. */
export interface ButtonEmbed {
  type: "button";
  link: Link;
}

export interface ImageEmbed {
  type: "image";
  media: Media;
}

export interface PullquoteEmbed {
  type: "pullquote";
  /** Plain text. */
  quote: string;
  attribution?: string;
}

/** A video or social post, by its page URL. The UI picks the player. */
export interface UrlEmbed {
  type: "embed";
  url: string;
  caption?: string;
}

export type RichTextBlock =
  | ButtonEmbed
  | ImageEmbed
  | PullquoteEmbed
  | UrlEmbed;

// Blocks -------------------------------------------------------------------

interface BlockBase<T extends string> {
  type: T;
  /** Stable id from the CMS, used as a React key. */
  id: string;
}

export interface ContentBlock<R> extends BlockBase<"content"> {
  eyebrow?: string;
  heading?: string;
  body?: R;
  links: Link[];
  align: "start" | "center";
}

export interface ContentMediaBlock<R> extends BlockBase<"contentMedia"> {
  eyebrow?: string;
  heading?: string;
  body?: R;
  links: Link[];
  media: Media;
  mediaPosition: "start" | "end";
}

export interface MediaBlock extends BlockBase<"media"> {
  media: Media;
}

export interface Card {
  id: string;
  title: string;
  /** Plain text. Cards are short; rich text here invites layout breakage. */
  text?: string;
  image?: Image;
  link?: Link;
}

export interface CardGridBlock extends BlockBase<"cardGrid"> {
  heading?: string;
  columns: 2 | 3 | 4;
  cards: Card[];
}

export interface BlockquoteBlock extends BlockBase<"blockquote"> {
  /** Plain text. */
  quote: string;
  attribution?: string;
  role?: string;
  image?: Image;
}

export interface CallToActionBlock<R> extends BlockBase<"callToAction"> {
  heading: string;
  body?: R;
  links: Link[];
}

/** Input types a form field can take. `message` is text between inputs. */
export const FORM_FIELD_TYPES = [
  "text",
  "email",
  "textarea",
  "number",
  "select",
  "checkbox",
  "message",
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormFieldOption {
  label: string;
  value: string;
}

export interface FormField<R> {
  type: FormFieldType;
  /** The submitted value's key. Empty for `message`. */
  name: string;
  label?: string;
  required: boolean;
  /** Percent of the row, e.g. 50 for two fields side by side. */
  width?: number;
  defaultValue?: string;
  /** For `select`. */
  options?: FormFieldOption[];
  /** For `message`. */
  message?: R;
}

/**
 * A form as the CMS defines it. The UI posts `{ formId, values }` as JSON to
 * `action`, where `values` maps each field's name to its value; each app owns
 * that endpoint and turns it into its CMS's submission.
 */
export interface Form<R> {
  id: string;
  action: string;
  fields: FormField<R>[];
  submitLabel: string;
  /** Shown in place of the form after a successful submission. */
  confirmation?: R;
}

export interface FormBlock<R> extends BlockBase<"form"> {
  heading?: string;
  body?: R;
  form: Form<R>;
}

export type Block<R> =
  | ContentBlock<R>
  | ContentMediaBlock<R>
  | MediaBlock
  | CardGridBlock
  | BlockquoteBlock
  | CallToActionBlock<R>
  | FormBlock<R>;

export type BlockType = Block<unknown>["type"];

/** One section of a page: a single block plus the options that frame it. */
export interface Section<R> {
  options: SectionOptions;
  block: Block<R>;
}

export interface Page<R> {
  title: string;
  /** Site-relative path, e.g. `/about`. */
  path: string;
  sections: Section<R>[];
}

// Helpers used by every adapter -----------------------------------------------

/**
 * A select field value as CMSs return it: a string, a one-item array
 * (WPGraphQL for ACF), null, or a value since removed from the field choices.
 */
export type SelectValue = string | string[] | null | undefined;

/** Returns `value` if it is one of `allowed`, otherwise `fallback`. */
export const oneOf = <T extends string>(
  allowed: readonly T[],
  value: SelectValue,
  fallback: T
): T => {
  const raw = Array.isArray(value) ? value[0] : value;

  return allowed.find((option) => option === raw) ?? fallback;
};

export const toSkin = (value: SelectValue): Skin =>
  oneOf(SKINS, value, DEFAULT_SECTION_OPTIONS.skin);

export const toWidth = (value: SelectValue): ContainerWidth =>
  oneOf(CONTAINER_WIDTHS, value, DEFAULT_SECTION_OPTIONS.width);

export const toSpacing = (
  value: SelectValue,
  fallback: Spacing = "md"
): Spacing => oneOf(SPACINGS, value, fallback);

const COLUMN_COUNTS = { "2": 2, "3": 3, "4": 4 } as const;

export const toColumns = (value: SelectValue): CardGridBlock["columns"] =>
  COLUMN_COUNTS[oneOf(["2", "3", "4"] as const, value, "3")];

export const toLinkVariant = (value: SelectValue): LinkVariant =>
  oneOf(LINK_VARIANTS, value, "primary");

/** Lowercase, hyphenated anchor id. Returns undefined for empty input. */
export const slugify = (
  value: string | null | undefined
): string | undefined => {
  if (!value) {
    return undefined;
  }

  const slug = value
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

  return slug || undefined;
};

/** Drops hidden sections. Adapters keep them so previews can show them. */
export const visibleSections = <R>(page: Page<R>): Section<R>[] =>
  page.sections.filter((section) => !section.options.hidden);

/** `T` with keys that may be undefined turned into optional keys. */
export type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

/**
 * Removes keys whose value is undefined. Adapters build objects with
 * `field ?? undefined` and pass them through this, which keeps output equal
 * across adapters and satisfies `exactOptionalPropertyTypes`.
 */
export const compact = <const T extends object>(value: T): Compact<T> =>
  // SAFETY: the entries are those of `value` minus undefined values, which is
  // exactly what `Compact<T>` describes.
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Compact<T>;
