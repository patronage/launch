import { UpstreamRequestError } from "@patronage/mcp-core";
import type {
  CallerContext,
  ConnectorDeps,
  ConnectorToolMap,
} from "@patronage/mcp-core";

import { createEmDashClient, emdashData } from "./emdash";
import { readArgsSchema, readablePath } from "./emdash-read";
import type { EmDashEnv } from "./env";

// This module names no codemode import and no `cloudflare:workers` binding,
// so the tool definitions stay testable with a stubbed `fetch` alone.
export const EMDASH_CONNECTOR_INSTRUCTIONS = [
  "EmDash site reached as the signed-in Cloudflare Access user, with that editor's EmDash role.",
  "Reads: emdash.get({path, query?}) GETs an EmDash REST path under /_emdash/api/ and returns its data, throwing on an error.",
  "It reads content (list, one entry, revisions, compare, translations, terms, references, trash), revisions, schema (collections, block types), media, menus, taxonomies and search.",
  "This connector does not write yet: change EmDash content in its admin.",
].join(" ");

export const EMDASH_EXECUTE_DESCRIPTION = [
  "The emdash global reaches the EmDash CMS.",
  "Reads: await emdash.get({ path, query? }), where path starts /_emdash/api/, contains no ?, and query values are scalars; it returns the response's data.",
  'Collections and their fields: emdash.get({ path: "/_emdash/api/schema/collections/pages", query: { includeFields: true } }).',
  'Entries: emdash.get({ path: "/_emdash/api/content/pages", query: { limit: 20 } }) returns { items, nextCursor, total }; emdash.get({ path: "/_emdash/api/content/pages/<id or slug>" }) returns { item, _rev }, where item.data holds the fields with any pending draft applied and item.status is draft, published or scheduled.',
  "Rich text fields (type portableText) are Portable Text arrays.",
  "EmDash has no writes through the gateway yet.",
].join(" ");

const callerClient = (env: EmDashEnv, caller: CallerContext) =>
  createEmDashClient(env, {
    subjectOpaque: caller.subjectOpaque,
    token: caller.token,
  });

export const createEmDashTools = (deps: ConnectorDeps<EmDashEnv>) =>
  ({
    get: {
      description:
        "GET an EmDash REST path under /_emdash/api/ (content, revisions, schema, media, menus, taxonomies or search). Returns the response's data, or throws on an error.",
      execute: async (args) => {
        const parsedArgs = readArgsSchema.safeParse(args);

        if (!parsedArgs.success) {
          throw new UpstreamRequestError(
            "emdash.get requires a string path and scalar query values"
          );
        }

        const path = readablePath(parsedArgs.data);
        const caller = deps.scope.require();

        return await emdashData(
          callerClient(deps.env, caller),
          path,
          deps.telemetry()
        );
      },
      inputSchema: {
        properties: {
          path: { type: "string" },
          query: { type: "object" },
        },
        required: ["path"],
        type: "object",
      },
    },
  }) satisfies ConnectorToolMap;
