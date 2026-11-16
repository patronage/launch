import type { SanitizedMCPPluginConfig } from "@payloadcms/plugin-mcp";
import type {
  CollectionSlug,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedConfig,
} from "payload";
import { describe, expect, it, vi } from "vitest";

import { collections as mcpCollections } from "./mcp";
import { markdownToRichText, richTextToMarkdown } from "./mcp-tools";
import type { LexicalNode } from "./seed/lexical";
import { posts } from "./seed/posts";

// The real Payload config, built and sanitized but never connected: no
// Worker bindings and no database, which building does not touch.
// oxlint-disable-next-line anti-slop/no-module-mocking -- workerd's module does not exist in node.
vi.mock(
  import("cloudflare:workers"),
  () =>
    // SAFETY: the config reads only `env`, and an empty one means no bindings.
    ({ env: {} }) as never
);

// oxlint-disable-next-line anti-slop/no-module-mocking -- building the config never opens the database.
vi.mock(import("./db"), () => ({
  // SAFETY: buildConfig keeps the adapter without calling it.
  database: () => Promise.resolve(undefined as never),
}));

const configModule = await import("./payload.config");
const config: SanitizedConfig = await configModule.default;

// What the MCP plugin made of the config: every tool it will offer, per
// collection and global. The plugin keeps this on its own options.
const mcpItems = (): SanitizedMCPPluginConfig["items"] => {
  const plugin = config.plugins?.find(
    (candidate) => candidate.slug === "@payloadcms/plugin-mcp"
  );

  // SAFETY: the MCP plugin stores its sanitized config here when it runs;
  // its own getPluginConfig() reads the same property.
  const sanitized = (
    plugin as { sanitizedOptions?: SanitizedMCPPluginConfig } | undefined
  )?.sanitizedOptions;

  if (!sanitized) {
    throw new Error("the MCP plugin did not run");
  }

  return sanitized.items;
};

// Payload adds its own `payload-*` collections after every plugin has run,
// so the MCP plugin never sees them and they get no tools.
const PAYLOAD_INTERNAL = /^payload-/u;

const pluginVisibleSlugs = config.collections
  .map(({ slug }) => slug)
  .filter((slug) => !PAYLOAD_INTERNAL.test(slug));

// Built-in tools that change data, by their config key.
const COLLECTION_WRITE_TOOLS = new Set([
  "create",
  "delete",
  "duplicate",
  "getUploadInstructions",
  "restoreVersion",
  "update",
  // Auth tools, which an auth collection may opt into.
  "auth",
  "forgotPassword",
  "login",
  "resetPassword",
  "unlock",
  "verify",
]);

const GLOBAL_WRITE_TOOLS = new Set(["restoreGlobalVersion", "update"]);

const toolsFor = (slug: string) =>
  mcpItems().flatMap((item) =>
    item.type === "collectionTool" && item.collectionSlug === slug
      ? [item.configKey]
      : []
  );

describe("Payload's MCP server", () => {
  it("sees the collections the site defines and its plugins add", () => {
    expect(pluginVisibleSlugs).toStrictEqual(
      expect.arrayContaining([
        "users",
        "pages",
        "posts",
        "media",
        "forms",
        "form-submissions",
        "redirects",
      ])
    );
  });

  it.each(pluginVisibleSlugs)(
    "lists the %s collection in its read-only map",
    (slug) => {
      expect(Object.keys(mcpCollections ?? {})).toContain(slug);
    }
  );

  it.each(pluginVisibleSlugs)("offers no write tool for %s", (slug) => {
    const writes = toolsFor(slug).filter((key) =>
      COLLECTION_WRITE_TOOLS.has(key)
    );

    expect(writes).toStrictEqual([]);
  });

  it("offers no write tool for any global", () => {
    const writes = mcpItems().flatMap((item) =>
      item.type === "globalTool" && GLOBAL_WRITE_TOOLS.has(item.configKey)
        ? [`${item.globalSlug}.${item.configKey}`]
        : []
    );

    expect(writes).toStrictEqual([]);
  });

  it("marks every tool it offers as read-only", () => {
    const notReadOnly = mcpItems().flatMap((item) => {
      if (item.type === "prompt" || item.type === "resource") {
        return [];
      }

      return item.tool.annotations?.readOnlyHint === true
        ? []
        : [item.configKey];
    });

    expect(notReadOnly).toStrictEqual([]);
  });

  it.each(["users", "form-submissions"])(
    "exposes no tool at all for %s, not even a read",
    (slug) => {
      expect(toolsFor(slug)).toStrictEqual([]);
    }
  );

  it("still offers reads for a visible collection", () => {
    expect(toolsFor("posts")).toStrictEqual(
      expect.arrayContaining([
        "find",
        "markdownToRichText",
        "richTextToMarkdown",
      ])
    );
  });
});

// The posts collection as Payload sanitized it, with its rich text editor.
const postsConfig = config.collections.find(
  (collection): collection is SanitizedCollectionConfig =>
    collection.slug === "posts"
);

if (!postsConfig) {
  throw new Error("no posts collection");
}

// The parts of a request the conversion tools read.
const requestParts = {
  payload: { blocks: {}, collections: { posts: { config: postsConfig } } },
  user: { collection: "users", email: "editor@example.com", id: 1 },
};

// SAFETY: the conversion handlers read only `payload.blocks`,
// `payload.collections` and `user`.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial request.
const request = requestParts as unknown as PayloadRequest;

const slug: CollectionSlug = "posts";

interface RichTextValue {
  root: LexicalNode;
}

interface MarkdownResult {
  isError?: boolean;
  structuredContent?: { lost: string[]; markdown: string };
}

interface RichTextResult {
  isError?: boolean;
  structuredContent?: { value: RichTextValue };
}

type HandlerArgs<T extends { handler: (args: never) => object }> = Parameters<
  T["handler"]
>[0];

const toMarkdown = async (
  value: RichTextValue,
  field = "content"
): Promise<MarkdownResult> => {
  const parts = { input: { field, value }, req: request, slug };

  // SAFETY: the handler reads only `input`, `req` and `slug`.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial call.
  const args = parts as unknown as HandlerArgs<typeof richTextToMarkdown>;

  // SAFETY: the handler returns its Markdown and lost node types this way.
  return (await richTextToMarkdown.handler(args)) as MarkdownResult;
};

const toRichText = async (
  markdown: string,
  field = "content"
): Promise<RichTextResult> => {
  const parts = { input: { field, markdown }, req: request, slug };

  // SAFETY: the handler reads only `input`, `req` and `slug`.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial call.
  const args = parts as unknown as HandlerArgs<typeof markdownToRichText>;

  // SAFETY: the handler returns the converted Lexical value this way.
  return (await markdownToRichText.handler(args)) as RichTextResult;
};

const markdownOf = async (value: RichTextValue) => {
  const { structuredContent } = await toMarkdown(value);

  if (!structuredContent) {
    throw new Error("no Markdown");
  }

  return structuredContent;
};

const richTextOf = async (markdown: string) => {
  const { structuredContent } = await toRichText(markdown);

  if (!structuredContent) {
    throw new Error("no rich text");
  }

  return structuredContent.value;
};

interface ReaderView {
  children?: ReaderView[];
  format?: LexicalNode["format"];
  listType?: string;
  tag?: string;
  text?: string;
  type: string;
}

// What a reader sees of a node: its kind, heading level, list style and text.
const readerView = (node: LexicalNode): ReaderView => {
  const view: ReaderView = { type: node.type };

  if (node.tag) {
    view.tag = node.tag;
  }

  if (node.listType) {
    view.listType = node.listType;
  }

  if (node.type === "text") {
    view.format = node.format;
    view.text = node.text;
  }

  if (node.children) {
    view.children = node.children.map(readerView);
  }

  return view;
};

const nodeTypes = (node: LexicalNode): string[] => [
  node.type,
  ...(node.children ?? []).flatMap(nodeTypes),
];

// Node types Markdown cannot carry back: blocks, inline blocks, and internal
// links, which Markdown has no document reference for.
const NOT_IN_MARKDOWN = new Set(["block", "inlineBlock", "link"]);

const id = () => 1;
const seedPosts = posts({ author: id, category: id, image: id, page: id });

type SeedContent = (typeof seedPosts)[number]["content"];

// SAFETY: the seed builds its rich text from `LexicalNode`s (seed/lexical.ts).
const seedRichText = (content: SeedContent) => content as RichTextValue;

// Each seed post's content, keeping only what Markdown can carry.
const markdownSafe = seedPosts.flatMap(({ content, slug: postSlug }) => {
  if (!content) {
    return [];
  }

  const { root } = seedRichText(content);

  const children = (root.children ?? []).filter((child) =>
    nodeTypes(child).every((type) => !NOT_IN_MARKDOWN.has(type))
  );

  return [[postSlug, { root: { ...root, children } }] as const];
});

describe("Markdown and rich text conversion", () => {
  it("writes a seed post as Markdown and names the nodes Markdown loses", async () => {
    const [first] = seedPosts;
    const { lost, markdown } = await markdownOf(seedRichText(first?.content));

    expect(markdown).toContain("## What happens next");
    expect(markdown).toContain(
      "- January: we confirm the four lots with the city land bank."
    );
    expect(lost).toStrictEqual(["block", "inlineBlock", "link"]);
  });

  it.each(markdownSafe)(
    "round trips the Markdown-safe content of %s unchanged",
    async (_, value) => {
      const { lost, markdown } = await markdownOf(value);

      expect(lost).toStrictEqual([]);

      const back = await richTextOf(markdown);

      expect(back.root.children?.map(readerView)).toStrictEqual(
        value.root.children?.map(readerView)
      );
      await expect(markdownOf(back)).resolves.toStrictEqual({
        lost: [],
        markdown,
      });
    }
  );

  it("turns Markdown into the field's Lexical nodes", async () => {
    const value = await richTextOf(
      "## Build day\n\nBring **gloves** and *water*.\n\n- Soil\n- Seeds"
    );

    expect(value.root.children?.map(readerView)).toStrictEqual([
      {
        children: [{ format: 0, text: "Build day", type: "text" }],
        tag: "h2",
        type: "heading",
      },
      {
        children: [
          { format: 0, text: "Bring ", type: "text" },
          { format: 1, text: "gloves", type: "text" },
          { format: 0, text: " and ", type: "text" },
          { format: 2, text: "water", type: "text" },
          { format: 0, text: ".", type: "text" },
        ],
        type: "paragraph",
      },
      {
        children: [
          {
            children: [{ format: 0, text: "Soil", type: "text" }],
            type: "listitem",
          },
          {
            children: [{ format: 0, text: "Seeds", type: "text" }],
            type: "listitem",
          },
        ],
        listType: "bullet",
        tag: "ul",
        type: "list",
      },
    ]);
  });

  it("refuses a field that is not rich text", async () => {
    await expect(toRichText("Hello", "title")).resolves.toMatchObject({
      isError: true,
    });
    await expect(
      toMarkdown(
        { root: { children: [], format: "", type: "root", version: 1 } },
        "excerpt"
      )
    ).resolves.toMatchObject({ isError: true });
  });
});
