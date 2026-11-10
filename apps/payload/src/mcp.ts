import { mcpPlugin } from "@payloadcms/plugin-mcp";
import type { MCPPluginConfig } from "@payloadcms/plugin-mcp";
import type { CollectionSlug } from "payload";

import {
  getEditingInfo,
  markdownToRichText,
  richTextToMarkdown,
} from "./mcp-tools";

// Payload's MCP server at /api/mcp, read-only. Writes reach Payload through
// the MCP gateway's approval step (ADR 0014), so every built-in tool that
// changes data is off here.
const READ_ONLY_COLLECTION = {
  tools: {
    create: false,
    delete: false,
    duplicate: false,
    getUploadInstructions: false,
    restoreVersion: false,
    update: false,
  },
} as const;

// Collections with a rich text field also convert Markdown both ways, so the
// gateway can take Markdown from a model and show Markdown to the approver.
const RICH_TEXT_COLLECTION = {
  tools: {
    ...READ_ONLY_COLLECTION.tools,
    markdownToRichText,
    richTextToMarkdown,
  },
};

const HIDDEN_COLLECTION = {
  tools: {
    count: false,
    countVersions: false,
    find: false,
    findDistinct: false,
    findVersionByID: false,
    findVersions: false,
    getCollectionSchema: false,
    ...READ_ONLY_COLLECTION.tools,
  },
} as const;

const collections: MCPPluginConfig["collections"] = {
  authors: READ_ONLY_COLLECTION,
  categories: READ_ONLY_COLLECTION,
  // Submissions hold what visitors typed into forms.
  "form-submissions": HIDDEN_COLLECTION,
  forms: READ_ONLY_COLLECTION,
  media: READ_ONLY_COLLECTION,
  pages: RICH_TEXT_COLLECTION,
  posts: RICH_TEXT_COLLECTION,
  redirects: READ_ONLY_COLLECTION,
  // Auth tools (login, password reset) stay off because they are opt-in.
  users: HIDDEN_COLLECTION,
};

// The collections MCP may describe: every one not hidden above.
// SAFETY: the keys of `collections` are collection slugs by its type.
const VISIBLE_COLLECTIONS = Object.entries(collections ?? {}).flatMap(
  ([slug, config]) =>
    config === HIDDEN_COLLECTION ? [] : [slug as CollectionSlug]
);

export const mcp = () =>
  mcpPlugin({
    collections,
    globals: {
      "site-settings": {
        tools: { restoreGlobalVersion: false, update: false },
      },
    },
    mcp: {
      serverOptions: { serverInfo: { name: "launch-payload" } },
    },
    tools: { getEditingInfo: getEditingInfo(VISIBLE_COLLECTIONS) },
  });
