import { mcpPlugin } from "@payloadcms/plugin-mcp";
import type { MCPPluginConfig } from "@payloadcms/plugin-mcp";

// Payload's MCP server at /api/mcp, read-only for now. Writes will reach
// Payload through the MCP gateway's approval step (ADR 0014), so every
// built-in tool that changes data is off here.
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
  pages: READ_ONLY_COLLECTION,
  posts: READ_ONLY_COLLECTION,
  // Auth tools (login, password reset) stay off because they are opt-in.
  users: HIDDEN_COLLECTION,
};

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
  });
