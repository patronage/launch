import { mcpPlugin } from "@payloadcms/plugin-mcp";
import type { MCPPluginConfig } from "@payloadcms/plugin-mcp";
import type { CollectionSlug, GlobalSlug } from "payload";

import {
  findGlobalDraft,
  getDocumentLock,
  getEditingInfo,
  getPreviewUrl,
  markdownToRichText,
  richTextToMarkdown,
} from "./mcp-tools";

// Payload's MCP server at /api/mcp, read-only. Writes reach Payload through
// the MCP gateway's approval step (ADR 0014), so every built-in tool that
// changes data is off here.
const NO_WRITES = {
  create: false,
  delete: false,
  duplicate: false,
  getUploadInstructions: false,
  restoreVersion: false,
  update: false,
} as const;

// `getDocumentLock` says whether another editor has a document open: the
// gateway asks before a write Payload itself would make over their lock.
const READ_ONLY_COLLECTION = {
  tools: { ...NO_WRITES, getDocumentLock },
};

// Collections with a rich text field also convert Markdown both ways, so the
// gateway can take Markdown from a model and show Markdown to the approver.
// Both have a front-end address, so they give its draft preview link too.
const RICH_TEXT_COLLECTION = {
  tools: {
    ...READ_ONLY_COLLECTION.tools,
    getPreviewUrl,
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
    ...NO_WRITES,
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

// A global is read as the admin opens it, newest version first, so an edit
// through the gateway starts from the same place.
const globals: MCPPluginConfig["globals"] = {
  "site-settings": {
    tools: { findGlobalDraft, restoreGlobalVersion: false, update: false },
  },
};

// SAFETY: the keys of `globals` are global slugs by its type.
const VISIBLE_GLOBALS = Object.keys(globals ?? {}) as GlobalSlug[];

export const mcp = () =>
  mcpPlugin({
    collections,
    globals,
    mcp: {
      serverOptions: { serverInfo: { name: "launch-payload" } },
    },
    // The plugin's own OAuth server would let an MCP client sign in to Payload
    // directly. Cloudflare Access is the only sign-in (ADR 0011), and the
    // gateway signs in through the `cloudflare-access-gateway` strategy.
    oauth: false,
    tools: {
      getEditingInfo: getEditingInfo(VISIBLE_COLLECTIONS, VISIBLE_GLOBALS),
    },
  });
