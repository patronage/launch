/**
 * The Payload page document shape for the `layout` blocks field, as returned by
 * the Local API or REST at depth 1. Field names follow @launch/content-model.
 * Hand-written to mirror apps/payload's generated `payload-types.ts`, which a
 * package cannot import.
 */

/** Fields Payload stores on `link` and `autolink` nodes. */
export interface LexicalLinkFields {
  linkType?: "custom" | "internal";
  newTab?: boolean;
  url?: string | null;
  doc?: PayloadReference | null;
}

/**
 * The subset of Lexical's serialized node that the renderer reads. Element
 * nodes carry `children`; text nodes carry `text` and a `format` bitmask.
 */
export interface LexicalNode {
  type: string;
  version: number;
  children?: LexicalNode[];
  text?: string;
  /** A bitmask on text nodes; an alignment string on element nodes. */
  format?: number | string;
  tag?: string;
  listType?: "bullet" | "number" | "check";
  /** Link fields on `link` nodes; the block's fields on `block` and `inlineBlock` nodes. */
  fields?: LexicalLinkFields | PayloadRichTextBlock;
}

export interface LexicalState {
  root: LexicalNode;
}

export interface PayloadBreadcrumb {
  url?: string | null;
}

export interface PayloadPageRef {
  id: number | string;
  slug?: string | null;
  /** Present when the nested-docs plugin is installed. */
  breadcrumbs?: PayloadBreadcrumb[] | null;
}

export interface PayloadReference {
  relationTo: string;
  /** A populated doc at depth >= 1, otherwise just its id. */
  value: PayloadPageRef | number | string;
}

export interface PayloadLink {
  type?: "reference" | "custom" | null;
  newTab?: boolean | null;
  reference?: PayloadReference | null;
  url?: string | null;
  label?: string | null;
  /** primary, secondary or text; card links have none. */
  variant?: string | null;
}

export interface PayloadMedia {
  id: number | string;
  alt?: string | null;
  caption?: string | null;
  url?: string | null;
  width?: number | null;
  height?: number | null;
}

/** An upload field: the populated doc at depth >= 1, otherwise its id. */
export type PayloadUpload = PayloadMedia | number | string | null | undefined;

export interface PayloadSectionOptions {
  skin?: string | null;
  width?: string | null;
  paddingTop?: string | null;
  paddingBottom?: string | null;
  hidden?: boolean | null;
  anchor?: string | null;
}

interface BlockBase<T extends string> {
  id?: string | null;
  blockType: T;
  blockName?: string | null;
  sectionOptions?: PayloadSectionOptions | null;
}

export interface ContentBlock extends BlockBase<"content"> {
  eyebrow?: string | null;
  heading?: string | null;
  body?: LexicalState | null;
  align?: string | null;
  links?: { id?: string | null; link: PayloadLink }[] | null;
}

export interface ContentMediaBlock extends BlockBase<"contentMedia"> {
  eyebrow?: string | null;
  heading?: string | null;
  body?: LexicalState | null;
  media?: PayloadUpload;
  mediaPosition?: string | null;
  links?: { id?: string | null; link: PayloadLink }[] | null;
}

export interface MediaBlock extends BlockBase<"media"> {
  media?: PayloadUpload;
}

export interface CardGridBlock extends BlockBase<"cardGrid"> {
  heading?: string | null;
  columns?: string | null;
  cards?:
    | {
        id?: string | null;
        title?: string | null;
        text?: string | null;
        image?: PayloadUpload;
        link?: PayloadLink | null;
      }[]
    | null;
}

export interface BlockquoteBlock extends BlockBase<"blockquote"> {
  quote?: string | null;
  attribution?: string | null;
  role?: string | null;
  image?: PayloadUpload;
}

export interface CallToActionBlock extends BlockBase<"callToAction"> {
  heading?: string | null;
  body?: LexicalState | null;
  links?: { id?: string | null; link: PayloadLink }[] | null;
}

/** A field block in the form-builder plugin's `fields`. */
export interface PayloadFormField {
  id?: string | null;
  blockType: string;
  name?: string | null;
  label?: string | null;
  required?: boolean | null;
  width?: number | null;
  /** Text for most fields; a boolean for checkboxes. */
  defaultValue?: string | number | boolean | null;
  options?: { label?: string | null; value?: string | null }[] | null;
  message?: LexicalState | null;
}

/** A form-builder `forms` document. */
export interface PayloadForm {
  id: number | string;
  fields?: PayloadFormField[] | null;
  submitButtonLabel?: string | null;
  confirmationType?: string | null;
  confirmationMessage?: LexicalState | null;
}

export interface FormBlock extends BlockBase<"form"> {
  heading?: string | null;
  body?: LexicalState | null;
  /** The populated form at depth >= 1, otherwise its id. */
  form?: PayloadForm | number | string | null;
}

export type LayoutBlock =
  | FormBlock
  | ContentBlock
  | ContentMediaBlock
  | MediaBlock
  | CardGridBlock
  | BlockquoteBlock
  | CallToActionBlock;

export interface UnknownBlock {
  id?: string | null;
  blockType: string;
  sectionOptions?: PayloadSectionOptions | null;
}

export interface PayloadPage {
  id: number | string;
  title?: string | null;
  slug?: string | null;
  breadcrumbs?: PayloadBreadcrumb[] | null;
  layout?: (LayoutBlock | UnknownBlock)[] | null;
}

// Rich-text blocks ------------------------------------------------------------

interface RichTextBlockBase<T extends string> {
  id?: string | null;
  blockType: T;
  blockName?: string | null;
}

export interface PayloadButtonEmbed extends RichTextBlockBase<"button"> {
  link?: PayloadLink | null;
}

export interface PayloadImageEmbed extends RichTextBlockBase<"image"> {
  image?: PayloadUpload;
  /** Overrides the media document's own caption. */
  caption?: string | null;
}

export interface PayloadPullquoteEmbed extends RichTextBlockBase<"pullquote"> {
  quote?: string | null;
  attribution?: string | null;
}

export interface PayloadUrlEmbed extends RichTextBlockBase<"embed"> {
  url?: string | null;
  caption?: string | null;
}

/** A block in rich text, as Payload stores it on the node's `fields`. */
export type PayloadRichTextBlock =
  | PayloadButtonEmbed
  | PayloadImageEmbed
  | PayloadPullquoteEmbed
  | PayloadUrlEmbed;
