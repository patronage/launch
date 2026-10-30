import type { ContentSection } from "../payload-types";

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
  fields?: LinkFields;
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
  version: 1;
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

type RichText = NonNullable<ContentSection["body"]>;

export const richText = (...children: LexicalNode[]): RichText =>
  // SAFETY: the builders above emit the serialized shape of Payload's default
  // Lexical nodes (root, paragraph, list, listitem, link, text), which is what
  // `RichText` describes node by node.
  ({ root: element("root", children) }) as RichText;
