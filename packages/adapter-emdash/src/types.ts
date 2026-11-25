/**
 * EmDash entry shapes this adapter reads, typed by hand from entries captured
 * against EmDash 1.5 (see fixtures/). `getEmDashEntry` and the REST API return
 * the same `data`.
 *
 * Field names are the ones apps/emdash/seed/build.ts defines. Every value
 * may be missing: EmDash stores what the editor saved, and an older entry can
 * predate a field.
 */

// Portable Text -----------------------------------------------------------------

export interface PortableTextSpan {
  _type: "span";
  _key?: string;
  text?: string;
  /** Decorators (`strong`, `em`, ...) and keys into the block's `markDefs`. */
  marks?: string[];
}

export interface PortableTextLink {
  _type: "link";
  _key: string;
  href?: string;
  blank?: boolean;
}

export interface PortableTextTextBlock {
  _type: "block";
  _key?: string;
  style?: string;
  listItem?: "bullet" | "number";
  level?: number;
  children?: (PortableTextSpan | { _type: string; _key?: string })[];
  markDefs?: (PortableTextLink | { _type: string; _key: string })[];
}

/** An image placed in rich text, as EmDash's editor stores it. */
export interface PortableTextImage {
  _type: "image";
  _key?: string;
  asset?: { _ref?: string; url?: string; src?: string };
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

/** Any other block, such as a plugin's; the renderer leaves it out. */
export interface PortableTextOther {
  _type: string;
  _key?: string;
}

export type PortableTextNode =
  | PortableTextTextBlock
  | PortableTextImage
  | PortableTextOther;

export type PortableText = PortableTextNode[];

// Fields ------------------------------------------------------------------------

/** An `image` field's value. Seeded and uploaded media live in R2 under `meta.storageKey`. */
export interface EmDashImage {
  id?: string;
  provider?: string;
  /** Set for external images. */
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  filename?: string;
  meta?: { storageKey?: string };
}

export interface EmDashLink {
  label?: string;
  url?: string;
  variant?: string;
  new_tab?: boolean;
}

export interface EmDashSectionOptions {
  section_skin?: string;
  section_width?: string;
  section_padding_top?: string;
  section_padding_bottom?: string;
  section_anchor?: string;
  section_hidden?: boolean;
}

interface BlockBase<T extends string> extends EmDashSectionOptions {
  _type: T;
  _key?: string;
  _version?: number;
}

export interface EmDashContentBlock extends BlockBase<"content"> {
  eyebrow?: string;
  heading?: string;
  body?: PortableText;
  links?: EmDashLink[];
  align?: string;
}

export interface EmDashContentMediaBlock extends BlockBase<"content_media"> {
  eyebrow?: string;
  heading?: string;
  body?: PortableText;
  links?: EmDashLink[];
  image?: EmDashImage;
  caption?: string;
  media_position?: string;
}

export interface EmDashMediaBlock extends BlockBase<"media"> {
  image?: EmDashImage;
  caption?: string;
}

export interface EmDashCard {
  title?: string;
  text?: string;
  image?: EmDashImage;
  link_label?: string;
  link_url?: string;
}

export interface EmDashCardGridBlock extends BlockBase<"card_grid"> {
  heading?: string;
  columns?: string;
  cards?: EmDashCard[];
}

export interface EmDashBlockquoteBlock extends BlockBase<"blockquote"> {
  quote?: string;
  attribution?: string;
  role?: string;
  image?: EmDashImage;
}

export interface EmDashCallToActionBlock extends BlockBase<"call_to_action"> {
  heading?: string;
  body?: PortableText;
  links?: EmDashLink[];
}

/**
 * A form from the forms plugin, placed by slug. The content model's form
 * block is built for a CMS that hands over its fields, so the adapter skips
 * this section and the app renders the plugin's own form.
 */
export interface EmDashFormBlock extends BlockBase<"form"> {
  heading?: string;
  body?: PortableText;
  form?: string;
}

export type EmDashSection =
  | EmDashContentBlock
  | EmDashContentMediaBlock
  | EmDashMediaBlock
  | EmDashCardGridBlock
  | EmDashBlockquoteBlock
  | EmDashCallToActionBlock;

/** A block type this adapter does not know, such as one added in the admin. */
export interface EmDashUnknownSection extends EmDashSectionOptions {
  _type: string;
  _key?: string;
}

export interface EmDashPageData {
  title?: string;
  hero_variant?: string;
  hero_eyebrow?: string;
  hero_title?: string;
  hero_subhead?: string;
  hero_image?: EmDashImage;
  hero_links?: EmDashLink[];
  hero_skin?: string;
  hero_align?: string;
  hero_body?: PortableText;
  sections?: (EmDashSection | EmDashUnknownSection)[];
  /**
   * Set by EmDash's live loader (getEmDashEntry), not stored in the entry's
   * fields: the database id (the entry's own `id` is its slug) and the SEO panel.
   */
  id?: string;
  seo?: EmDashSeo;
}

// News --------------------------------------------------------------------------

/** A taxonomy term on an entry, as EmDash's loader attaches it under `terms`. */
export interface EmDashTerm {
  slug?: string;
  label?: string;
}

/**
 * A `news` entry's data from `getEmDashCollection` or `getEmDashEntry`. The
 * loader adds `id`, `publishedAt` (a Date there, a string over REST) and
 * `terms`, keyed by taxonomy name.
 */
export interface EmDashNewsData {
  title?: string;
  excerpt?: string;
  featured_image?: EmDashImage | null;
  body?: PortableText;
  id?: string;
  slug?: string | null;
  publishedAt?: string | Date | null;
  terms?: { category?: EmDashTerm[]; tag?: EmDashTerm[] };
  seo?: EmDashSeo;
}

/** A `category_details` entry's data: what a category term can't hold. */
export interface EmDashCategoryDetailsData {
  title?: string;
  image?: EmDashImage | null;
  intro?: string;
}

// Entries -----------------------------------------------------------------------

export interface EmDashSeo {
  title?: string | null;
  description?: string | null;
  noIndex?: boolean;
}

/** One entry from `GET /_emdash/api/content/{collection}/{slug-or-id}`. */
export interface EmDashEntry<D = EmDashPageData> {
  id: string;
  type: string;
  slug: string | null;
  status: string;
  data: D;
  seo?: EmDashSeo;
  updatedAt?: string;
  publishedAt?: string | null;
}

/**
 * The response body of a single read. When a published entry has unpublished
 * edits and the token can see drafts, `item.data` holds the draft and
 * `liveData` the published values.
 */
export interface EmDashEntryResponse<D = EmDashPageData> {
  item: EmDashEntry<D>;
  liveData?: D;
}
