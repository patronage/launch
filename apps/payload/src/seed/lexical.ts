import type {
  ContentSection,
  RichTextButton,
  RichTextEmbed,
  RichTextImage,
  RichTextPullquote,
} from "../payload-types";

/**
 * Small builders for the Lexical JSON that Payload's editor stores, so the seed
 * reads like the page it creates.
 */

interface LinkFields {
  doc: { relationTo: "pages"; value: number };
  linkType: "internal";
  newTab: boolean;
}

/** The parts of Lexical's serialized nodes that the seed writes. */
export interface LexicalNode {
  children?: LexicalNode[];
  detail?: number;
  direction?: "ltr";
  fields?:
    | LinkFields
    | RichTextButton
    | RichTextEmbed
    | RichTextImage
    | RichTextPullquote;
  format: number | "";
  indent?: number;
  listType?: "bullet";
  mode?: "normal";
  start?: number;
  style?: string;
  tag?: "h2" | "h3" | "ul";
  text?: string;
  textFormat?: number;
  textStyle?: string;
  type: string;
  value?: number;
  version: 1 | 2;
}

/** Lexical's text format bitmask values. */
const FORMAT = { bold: 1, italic: 2 } as const;

const element = (
  type: string,
  children: LexicalNode[],
  extra: Partial<LexicalNode> = {}
): LexicalNode => ({
  children,
  direction: "ltr",
  format: "",
  indent: 0,
  type,
  version: 1,
  ...extra,
});

export const text = (
  value: string,
  format?: keyof typeof FORMAT
): LexicalNode => ({
  detail: 0,
  format: format ? FORMAT[format] : 0,
  mode: "normal",
  style: "",
  text: value,
  type: "text",
  version: 1,
});

type Inline = LexicalNode | string;

const inline = (children: Inline[]): LexicalNode[] =>
  children.map((child) => (child instanceof Object ? child : text(child)));

export const paragraph = (...children: Inline[]): LexicalNode =>
  element("paragraph", inline(children), { textFormat: 0, textStyle: "" });

export const heading = (tag: "h2" | "h3", ...children: Inline[]): LexicalNode =>
  element("heading", inline(children), { tag });

export const bulletList = (...items: Inline[][]): LexicalNode =>
  element(
    "list",
    items.map((item, index) =>
      element("listitem", inline(item), { value: index + 1 })
    ),
    { listType: "bullet", start: 1, tag: "ul" }
  );

/** A link to another page, stored by id and resolved to a path on render. */
export const pageLink = (label: string, pageId: number): LexicalNode =>
  element("link", [text(label)], {
    fields: {
      doc: { relationTo: "pages", value: pageId },
      linkType: "internal",
      newTab: false,
    },
  });

let blockCount = 0;

/**
 * Block ids in Lexical are the editor's own; the seed numbers them in order,
 * so running it again writes the same ids.
 */
const blockId = () => {
  blockCount += 1;

  return `seed${String(blockCount).padStart(20, "0")}`;
};

/** An image, pullquote or embed between paragraphs. */
export const block = (
  fields:
    | Omit<RichTextEmbed, "id">
    | Omit<RichTextImage, "id">
    | Omit<RichTextPullquote, "id">
): LexicalNode => ({
  fields: { ...fields, blockName: "", id: blockId() },
  format: "",
  type: "block",
  version: 2,
});

/** A button inside a paragraph. */
export const button = (link: RichTextButton["link"]): LexicalNode => ({
  fields: { blockType: "button", id: blockId(), link },
  format: "",
  type: "inlineBlock",
  version: 1,
});

type RichText = NonNullable<ContentSection["body"]>;

export const richText = <T = RichText>(...children: LexicalNode[]): T =>
  // SAFETY: the builders above emit the serialized shape of Payload's Lexical
  // nodes (root, paragraph, list, listitem, link, text, block, inlineBlock),
  // which is what each editor's rich-text type describes node by node.
  ({ root: element("root", children) }) as T;
