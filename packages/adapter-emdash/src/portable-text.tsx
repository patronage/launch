import { Fragment } from "react";
import type { ReactNode } from "react";

import type {
  PortableText,
  PortableTextImage,
  PortableTextLink,
  PortableTextNode,
  PortableTextSpan,
  PortableTextTextBlock,
} from "./types";

/**
 * A small Portable Text to React renderer covering what EmDash's editor writes
 * for body copy: paragraphs, headings, quotes, bullet and numbered lists,
 * decorators and links. Images go to `renderImage`; other block types (a
 * plugin's, say) are left out.
 */

export interface PortableTextRenderOptions {
  /** Draws an image placed in the rich text. Without it, images are left out. */
  renderImage?: (image: PortableTextImage) => ReactNode;
}

/** Decorators, innermost wrapper first. */
const DECORATORS = [
  { mark: "code", tag: "code" },
  { mark: "strike-through", tag: "s" },
  { mark: "underline", tag: "u" },
  { mark: "em", tag: "em" },
  { mark: "strong", tag: "strong" },
] as const;

const HEADING_TAGS = ["h2", "h3", "h4", "h5", "h6"] as const;

/** Only these link schemes render as links; anything else keeps its text. */
const SAFE_HREF = /^(?:https?:|mailto:|tel:|\/(?!\/)|#)/iu;

const isTextBlock = (node: PortableTextNode): node is PortableTextTextBlock =>
  node._type === "block";

const isImage = (node: PortableTextNode): node is PortableTextImage =>
  node._type === "image";

const isSpan = (child: { _type: string }): child is PortableTextSpan =>
  child._type === "span";

const isLink = (def: { _type: string }): def is PortableTextLink =>
  def._type === "link";

const renderSpan = (
  span: PortableTextSpan,
  block: PortableTextTextBlock,
  key: number
): ReactNode => {
  const marks = span.marks ?? [];
  let content: ReactNode = span.text ?? "";

  for (const { mark, tag: Tag } of DECORATORS) {
    if (marks.includes(mark)) {
      content = <Tag>{content}</Tag>;
    }
  }

  const link = (block.markDefs ?? [])
    .filter(isLink)
    .find((def) => marks.includes(def._key));

  if (link?.href && SAFE_HREF.test(link.href)) {
    content = (
      <a
        href={link.href}
        {...(link.blank
          ? { rel: "noopener noreferrer", target: "_blank" }
          : {})}
      >
        {content}
      </a>
    );
  }

  return <Fragment key={key}>{content}</Fragment>;
};

const renderChildren = (block: PortableTextTextBlock): ReactNode[] =>
  (block.children ?? []).map((child, index) =>
    isSpan(child) ? renderSpan(child, block, index) : null
  );

const renderTextBlock = (
  block: PortableTextTextBlock,
  key: number
): ReactNode => {
  const children = renderChildren(block);
  const style = block.style ?? "normal";

  if (style === "blockquote") {
    return <blockquote key={key}>{children}</blockquote>;
  }

  // Rich-text headings never outrank the section heading.
  const Heading =
    style === "h1" ? "h2" : HEADING_TAGS.find((tag) => tag === style);

  return Heading ? (
    <Heading key={key}>{children}</Heading>
  ) : (
    <p key={key}>{children}</p>
  );
};

type Run =
  | { kind: "list"; type: "bullet" | "number"; items: PortableTextTextBlock[] }
  | { kind: "node"; node: PortableTextNode };

/** Groups consecutive list items, which Portable Text stores flat, into lists. */
const toRuns = (nodes: PortableText): Run[] => {
  const runs: Run[] = [];

  for (const node of nodes) {
    const listType = isTextBlock(node) ? node.listItem : undefined;
    const last = runs.at(-1);

    if (listType && isTextBlock(node)) {
      if (last?.kind === "list" && last.type === listType) {
        last.items.push(node);
      } else {
        runs.push({ items: [node], kind: "list", type: listType });
      }
    } else {
      runs.push({ kind: "node", node });
    }
  }

  return runs;
};

/** True when the text has something to show; a cleared editor holds one empty block. */
export const hasPortableText = (nodes: PortableText | undefined): boolean =>
  (nodes ?? []).some(
    (node) =>
      !isTextBlock(node) ||
      (node.children ?? []).some(
        (child) => !isSpan(child) || (child.text ?? "").trim() !== ""
      )
  );

export const renderPortableText = (
  nodes: PortableText | undefined,
  options: PortableTextRenderOptions = {}
): ReactNode | undefined => {
  if (!(nodes && hasPortableText(nodes))) {
    return undefined;
  }

  return toRuns(nodes).map((run, index) => {
    if (run.kind === "list") {
      const Tag = run.type === "number" ? "ol" : "ul";

      return (
        <Tag key={index}>
          {run.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderChildren(item)}</li>
          ))}
        </Tag>
      );
    }

    if (isTextBlock(run.node)) {
      return renderTextBlock(run.node, index);
    }

    if (isImage(run.node)) {
      return <Fragment key={index}>{options.renderImage?.(run.node)}</Fragment>;
    }

    return null;
  });
};
