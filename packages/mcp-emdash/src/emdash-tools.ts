import { MAX_OPERATIONS, UpstreamRequestError } from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  CallerContext,
  ConnectorDeps,
  ConnectorToolMap,
} from "@patronage/mcp-core";

import {
  createEmDashClient,
  emdashAdminUrl,
  emdashData,
  emdashSiteUrl,
} from "./emdash";
import { applyOperations } from "./emdash-apply";
import type { EmDashLinks } from "./emdash-apply";
import { parseApplyInput } from "./emdash-operations";
import { readArgsSchema, readablePath } from "./emdash-read";
import type { EmDashEnv } from "./env";

// This module names no codemode import and no `cloudflare:workers` binding,
// so the tool definitions stay testable with a stubbed `fetch` alone.
export const EMDASH_CONNECTOR_INSTRUCTIONS = [
  "EmDash site reached as the signed-in Cloudflare Access user, with that editor's EmDash role.",
  "Reads: emdash.get({path, query?}) GETs an EmDash REST path under /_emdash/api/ and returns its data, throwing on an error.",
  "It reads content (list, one entry, revisions, compare, translations, terms, references, trash), revisions, schema (collections, block types), media, menus, taxonomies and search.",
  `Writes: emdash.apply({intent, operations}) is the only write path, with 1-${MAX_OPERATIONS} update_draft, create_draft or publish operations, one per entry.`,
  "update_draft and create_draft save a draft revision; the public site changes only with a publish operation, sent only when the person asked to publish.",
  "Do every read before emdash.apply: once the write is applied, reads later in the script are refused, and the returned receipt reports the result.",
].join(" ");

export const EMDASH_EXECUTE_DESCRIPTION = [
  "The emdash global reaches the EmDash CMS.",
  "Reads: await emdash.get({ path, query? }), where path starts /_emdash/api/, contains no ?, and query values are scalars; it returns the response's data.",
  'Collections and their fields: emdash.get({ path: "/_emdash/api/schema/collections/pages", query: { includeFields: true } }).',
  'Entries: emdash.get({ path: "/_emdash/api/content/pages", query: { limit: 20 } }) returns { items, nextCursor, total }; emdash.get({ path: "/_emdash/api/content/pages/<id or slug>" }) returns { item, _rev }, where item.data holds the fields with any pending draft applied and item.status is draft, published or scheduled.',
  "Rich text fields (type portableText) are Portable Text arrays.",
  "Search (/_emdash/api/search) is EmDash's public search and returns published entries only; list a collection to find drafts.",
  'Writes: await emdash.apply({ intent, operations }), with 1-20 operations, one per entry, shaped { kind: "update_draft", collection, id, fields, expected_rev? }, { kind: "create_draft", collection, fields, slug? } or { kind: "publish", collection, id, expected_rev? }. fields maps field slugs (from describe_site) to values, top-level fields only; a portableText field takes a whole Portable Text array, such as [{ _type: "block", _key: "a1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "a2", text: "Hello", marks: [] }] }]. Read the entry first and copy its _rev into expected_rev; id is the entry id, not its slug.',
  "update_draft and create_draft save a draft and change nothing public. A publish puts the entry's draft on the public site; send it only when the person asked to publish, as its own call after the save, with the rev the save's receipt reports (details.rev).",
].join(" ");

export const emdashLinks = (env: EmDashEnv): EmDashLinks => ({
  adminUrl: (collection, id) => emdashAdminUrl(env, collection, id),
  siteUrl: emdashSiteUrl(env),
});

const callerClient = (env: EmDashEnv, caller: CallerContext) =>
  createEmDashClient(env, {
    subjectOpaque: caller.subjectOpaque,
    token: caller.token,
  });

export const createEmDashTools = (deps: ConnectorDeps<EmDashEnv>) =>
  ({
    apply: {
      description: `Apply 1-${MAX_OPERATIONS} update_draft, create_draft or publish operations to EmDash, one per entry. Give the work a concise, one-sentence intent that says what the change is for. Returns one receipt per operation.`,
      execute: async (args, ctx?) => {
        // Validation runs first, so a malformed batch fails as a typed error
        // rather than as a half-applied write.
        const input = parseApplyInput(args);
        const caller = deps.scope.require();
        const executionId = ctx?.executionId ?? caller.executionId;

        if (executionId === undefined) {
          throw new UpstreamRequestError(
            "emdash.apply requires an execution id from the codemode runtime"
          );
        }

        // Only the stored preview authorises a write. With none stored, every
        // operation reports `missing_preflight` and nothing reaches EmDash.
        const preflight: ApplyPreflight = caller.preflight ??
          (await deps.store.readPreflight(executionId)) ?? {
            intent: input.intent,
            operations: [],
          };

        return await applyOperations({
          approverOpaque: caller.subjectOpaque,
          client: callerClient(deps.env, caller),
          executionId,
          links: emdashLinks(deps.env),
          onProgress: async (receipt) => {
            await deps.store.recordProgress?.(executionId, receipt);
          },
          operations: input.operations,
          preflight,
          requesterOpaque:
            (await deps.store.readRequester(executionId)) ?? "unknown",
          telemetry: deps.telemetry(),
        });
      },
      inputSchema: {
        properties: {
          intent: { type: "string" },
          operations: { items: { type: "object" }, type: "array" },
        },
        required: ["intent", "operations"],
        type: "object",
      },
      requiresApproval: true,
    },
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
