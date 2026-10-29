import { Fragment } from "react";
import type { ReactNode } from "react";

import type {
  LexicalNode,
  LexicalState,
  PayloadPageRef,
  PayloadReference,
} from "./types";

/**
 * A small Lexical JSON to React renderer covering the nodes the default Payload
 * editor produces for body copy. Payload ships a fuller one in
 * `@payloadcms/richtext-lexical/react`; an app that already depends on Payload
 * can pass that in through `renderRichText` instead.
 */

export interface LexicalRenderOptions {
  /** Turns an internal link's document into a site path. */
  resolveDoc: (doc: PayloadReference) => string | undefined;
}

/** Lexical text format flags, innermost wrapper first. */
const TEXT_FORMATS = [
  { flag: 16, tag: "code" },
  { flag: 32, tag: "sub" },
  { flag: 64, tag: "sup" },
  { flag: 4, tag: "s" },
  { flag: 8, tag: "u" },
  { flag: 2, tag: "em" },
  { flag: 1, tag: "strong" },
] as const;

const HEADING_TAGS = ["h2", "h3", "h4", "h5", "h6"] as const;

/** Reads one bit of Lexical's format bitmask without bitwise operators. */
const hasFormat = (format: number, flag: number): boolean =>
  Math.floor(format / flag) % 2 === 1;

const renderText = (node: LexicalNode, key: number): ReactNode => {
  // Text nodes store a numeric bitmask; anything else means no formatting.
  const format = Number(node.format) || 0;

  let content: ReactNode = node.text ?? "";

  for (const { flag, tag: Tag } of TEXT_FORMATS) {
    if (hasFormat(format, flag)) {
      content = <Tag>{content}</Tag>;
    }
  }

  return <Fragment key={key}>{content}</Fragment>;
};

export const isPopulatedPage = (
  value: PayloadReference["value"]
): value is PayloadPageRef => value instanceof Object;

const renderLink = (
  node: LexicalNode,
  key: number,
  children: ReactNode,
  options: LexicalRenderOptions
): ReactNode => {
  const fields = node.fields ?? {};

  const href =
    fields.linkType === "internal" && fields.doc
      ? options.resolveDoc(fields.doc)
      : fields.url;

  return (
    <a
      href={href ?? "#"}
      key={key}
      {...(fields.newTab
        ? { rel: "noopener noreferrer", target: "_blank" }
        : {})}
    >
      {children}
    </a>
  );
};

const renderNode = (
  node: LexicalNode,
  key: number,
  options: LexicalRenderOptions
): ReactNode => {
  const children = node.children?.map((child, index) =>
    renderNode(child, index, options)
  );

  switch (node.type) {
    case "text": {
      return renderText(node, key);
    }

    case "linebreak": {
      return <br key={key} />;
    }

    case "paragraph": {
      return <p key={key}>{children}</p>;
    }

    case "heading": {
      // Rich-text headings never outrank the block heading.
      const Tag = HEADING_TAGS.find((tag) => tag === node.tag) ?? "h2";

      return <Tag key={key}>{children}</Tag>;
    }

    case "quote": {
      return <blockquote key={key}>{children}</blockquote>;
    }

    case "list": {
      const Tag = node.listType === "number" ? "ol" : "ul";

      return <Tag key={key}>{children}</Tag>;
    }

    case "listitem": {
      return <li key={key}>{children}</li>;
    }

    case "link": {
      return renderLink(node, key, children, options);
    }

    case "autolink": {
      return renderLink(node, key, children, options);
    }

    case "horizontalrule": {
      return <hr key={key} />;
    }

    default: {
      // Unknown nodes (custom blocks, uploads) keep their text so nothing silently vanishes.
      return children ? <Fragment key={key}>{children}</Fragment> : null;
    }
  }
};

export const renderLexical = (
  state: LexicalState,
  options: LexicalRenderOptions
): ReactNode | undefined => {
  const nodes = state.root.children ?? [];

  // An editor the author cleared still holds one empty paragraph.
  const hasContent = nodes.some(
    (node) => node.type !== "paragraph" || (node.children?.length ?? 0) > 0
  );

  return hasContent
    ? nodes.map((node, index) => renderNode(node, index, options))
    : undefined;
};
