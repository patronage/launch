import { MAX_OPERATIONS, UpstreamRequestError } from "@patronage/mcp-core";
import type {
  ApplyPreflight,
  CallerContext,
  ConnectorDeps,
  ConnectorToolMap,
  JsonObject,
  UpstreamClient,
} from "@patronage/mcp-core";
import { z } from "zod";

import type { PayloadEnv } from "./env";
import {
  createPayloadClient,
  payloadAdminUrl,
  payloadGlobalAdminUrl,
  payloadMcpRequest,
  payloadSiteUrl,
  toPayloadToolResult,
} from "./payload";
import { applyDraftOperations } from "./payload-apply";
import {
  MAX_ROW_CHANGES,
  MAX_ROW_INSERTS,
  parseDraftApplyInput,
} from "./payload-operations";
import { stageUpload } from "./payload-upload";

// Payload's built-in tools that only read, and the read-only ones
// apps/payload adds (editing info, the draft preview link and the two rich
// text conversions). Payload's own config already turns
// every write off (apps/payload/src/mcp.ts); this list keeps reads the only
// thing `payload.call` can reach should that config ever change, because a
// write here would skip the approval `payload.apply` goes through.
export const PAYLOAD_READ_TOOLS = new Set([
  "countDocuments",
  "countGlobalVersions",
  "countVersions",
  "findDistinct",
  "findDocuments",
  "findGlobal",
  "findGlobalDraft",
  "findGlobalVersionByID",
  "findGlobalVersions",
  "findVersionByID",
  "findVersions",
  "getCollectionSchema",
  "getConfigInfo",
  "getEditingInfo",
  "getGlobalSchema",
  "getPreviewUrl",
  "markdownToRichText",
  "richTextToMarkdown",
]);

export const PAYLOAD_CONNECTOR_INSTRUCTIONS = [
  "Payload CMS, read through Payload's own MCP tools as the signed-in editor.",
  'Reads: payload.tools() lists the read tools and their input schemas; payload.call({tool, arguments}) runs one, e.g. payload.call({tool: "findDocuments", arguments: {slug: "posts", where: {slug: {equals: "hello"}}, draft: true}}). Results are {isError, text, structured?}; the documents are JSON inside text.',
  `Writes: payload.apply({intent, operations}) pauses for human approval and saves each change as a draft. Send 1-${MAX_OPERATIONS} operations shaped {kind: "update_draft", collection, id, fields?, markdown?, publish?, expected_updated_at?} or {kind: "create_draft", collection, fields?, markdown?, publish?}. Add publish: true only when the person asked to publish; the approval shows it, and an update with publish: true and no fields publishes the current draft. fields holds top-level field values as Payload stores them; markdown holds rich text fields as Markdown, which Payload converts with the field's editor features. payload.call({tool: "getEditingInfo", arguments: {}}) lists which collections keep drafts and which fields are rich text. Before an update, read with draft: true and copy updatedAt to expected_updated_at.`,
  `Rows: to change part of an array or blocks field (page sections, cards, links) without resending the field, send {kind: "patch_rows", collection, id, expected_updated_at, publish?, changes} with 1-${MAX_ROW_CHANGES} changes, applied in order: {op: "set", path, value} for one field of a row; {op: "set_markdown", path, markdown} for a rich text field of a row; {op: "insert", field, after_id, row} for a new row (after_id: null puts it first; a blocks row needs blockType; no id; at most ${MAX_ROW_INSERTS} inserts in one operation); {op: "remove", field, row_id}; {op: "move", field, row_id, after_id}. A path is field names joined by dots with [id=<row id>] after each array or blocks field, such as layout[id=6650a1f2].cards[id=b7c1].title; field is the same, ending at the array or blocks field. Read the document with draft: true and depth: 0 for the row ids and updatedAt; describe_site lists each collection's rowFields. Rows the changes do not name are sent back as they were read. The receipt gives the ids of new rows, comma-separated in the order they were inserted, under details.inserted_row_ids.`,
  'Globals: to change a global (site settings, a footer), send {kind: "update_global", global, expected_updated_at, fields?, changes?, publish?}. fields holds top-level values as Payload stores them, and changes takes the same row changes as patch_rows, except set_markdown. Read the global with payload.call({tool: "findGlobalDraft", arguments: {slug, depth: 0}}), which answers {structured: {doc}} with its newest version, and copy doc.updatedAt; findGlobal reads the published global, whose updatedAt is refused as stale while a newer draft exists. describe_site lists the globals, whether each keeps drafts and whether another editor has it open (locked: true, and then a write is refused until they finish): one with drafts is saved as a draft unless publish: true; one without drafts is live as soon as it is saved, so there the operation is refused unless it says publish: true, which you add only when the person asked for the change to go live.',
  'Unpublish: to take a published document off the public site and keep its content as a draft, send {kind: "unpublish", collection, id, expected_updated_at}, only when the person asked to unpublish it. Read the document with draft: true and copy updatedAt. Its public page stops being served as soon as the change is approved, and the approval says so and names the page; links to it 404 unless a redirect covers them, which this operation does not check or make. A document that is not published is refused (already_draft). To publish one again, send {kind: "update_draft", collection, id, publish: true} with no fields.',
  'Files: first stage the file with payload.stageUpload({collection, source: {url}}) for a URL the collection allows (describe_site lists them under upload.urlAllowList; null means it takes none), or source: {base64, filename, mimeType} for a very small file: the whole script is at most 20,000 characters, which leaves room for about 14 KB of file, so anything larger has to come from a URL. It returns {upload_ref, filename, mimeType, bytes, width?, height?} and writes nothing. Then payload.apply an operation shaped {kind: "upload_media", collection, upload_ref, filename?, fields?} for a new file, or {kind: "replace_media_file", collection, id, upload_ref, expected_updated_at, filename?, fields?} to replace the file of an existing document, which changes it at once everywhere it is used. fields holds the other fields of the document, such as alt. The receipt gives the new id, filename and url under details. SVG files are refused.',
  "Do every read before payload.apply: once the write is approved, reads later in the script are refused, and the returned receipt reports the result.",
].join(" ");

const callArgsSchema = z.object({
  arguments: z.record(z.string(), z.json()).optional(),
  tool: z.string().min(1).max(64),
});

const toolListSchema = z.object({
  tools: z.array(
    z.object({
      description: z.string().optional(),
      inputSchema: z.json().optional(),
      name: z.string(),
    })
  ),
});

const callerClient = (env: PayloadEnv, caller: CallerContext): UpstreamClient =>
  createPayloadClient(env, {
    subjectOpaque: caller.subjectOpaque,
    token: caller.token,
  });

export const createPayloadTools = (
  deps: ConnectorDeps<PayloadEnv>
): ConnectorToolMap =>
  ({
    apply: {
      description: `Save 1-${MAX_OPERATIONS} operations: update_draft or create_draft as Payload drafts (published where an operation sets publish: true), patch_rows to change, insert, remove or move single rows of an array or blocks field by row id, update_global to change a global's fields and rows, unpublish to take a published document off the public site, upload_media for a file staged with payload.stageUpload, or replace_media_file for a new file on an existing upload document. Give the work a concise, one-sentence intent for the human approval card. Pauses for human approval; returns one receipt per operation.`,
      execute: async (args, ctx) => {
        const input = parseDraftApplyInput(args);
        const caller = deps.scope.require();
        const executionId = ctx?.executionId ?? caller.executionId;

        if (executionId === undefined) {
          throw new UpstreamRequestError(
            "payload.apply requires an execution id from the codemode runtime"
          );
        }

        // As for wp.apply: only the preview a human approved authorises a
        // write, and with none every operation reports missing_preflight.
        const preflight: ApplyPreflight = caller.preflight ??
          (await deps.store.readPreflight(executionId)) ?? {
            intent: input.intent,
            operations: [],
          };

        return await applyDraftOperations({
          approverOpaque: caller.subjectOpaque,
          client: callerClient(deps.env, caller),
          executionId,
          files: { images: deps.env.IMAGES, store: deps.store },
          onProgress: async (receipt) => {
            await deps.store.recordProgress?.(executionId, receipt);
          },
          operations: input.operations,
          preflight,
          requesterOpaque:
            (await deps.store.readRequester(executionId)) ?? "unknown",
          siteUrl: payloadSiteLink(deps.env),
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
    call: {
      description:
        "Run one of Payload's read tools (see payload.tools()) as the signed-in editor. Returns {isError, text, structured?}.",
      execute: async (args) => {
        const parsed = callArgsSchema.safeParse(args);

        if (!parsed.success) {
          throw new UpstreamRequestError(
            "payload.call requires a tool name and an arguments object"
          );
        }

        if (!PAYLOAD_READ_TOOLS.has(parsed.data.tool)) {
          throw new UpstreamRequestError(
            `payload.call runs read tools only; make changes with payload.apply, which pauses for approval`
          );
        }

        const result = toPayloadToolResult(
          await payloadMcpRequest(
            callerClient(deps.env, deps.scope.require()),
            "tools/call",
            {
              arguments: parsed.data.arguments ?? {},
              name: parsed.data.tool,
            },
            deps.telemetry()
          )
        );

        const value: JsonObject = {
          isError: result.isError,
          text: result.text,
        };

        if (result.structured) {
          value.structured = result.structured;
        }

        return value;
      },
      inputSchema: {
        properties: {
          arguments: { type: "object" },
          tool: { type: "string" },
        },
        required: ["tool"],
        type: "object",
      },
    },
    stageUpload: {
      description:
        "Keep a file in the gateway for a later upload_media or replace_media_file operation in the same script. Takes {collection, source: {url}} for a URL on the collection's allow-list, or {collection, source: {base64, filename, mimeType}} for a very small file (a script holds about 14 KB of one). Writes nothing to Payload. Returns {upload_ref, filename, mimeType, bytes, width?, height?}.",
      execute: async (args, ctx) => {
        const caller = deps.scope.require();
        const executionId = ctx?.executionId ?? caller.executionId;

        if (executionId === undefined) {
          throw new UpstreamRequestError(
            "payload.stageUpload requires an execution id from the codemode runtime"
          );
        }

        return await stageUpload(
          {
            client: callerClient(deps.env, caller),
            executionId,
            images: deps.env.IMAGES,
            store: deps.store,
            telemetry: deps.telemetry(),
          },
          args
        );
      },
      inputSchema: {
        properties: {
          collection: { type: "string" },
          source: { type: "object" },
        },
        required: ["collection", "source"],
        type: "object",
      },
    },
    tools: {
      description:
        "List the Payload read tools this editor can run, with their input schemas.",
      execute: async () => {
        const listed = toolListSchema.safeParse(
          await payloadMcpRequest(
            callerClient(deps.env, deps.scope.require()),
            "tools/list",
            {},
            deps.telemetry()
          )
        );

        if (!listed.success) {
          throw new UpstreamRequestError(
            "Payload returned an invalid tool list"
          );
        }

        return listed.data.tools
          .filter((tool) => PAYLOAD_READ_TOOLS.has(tool.name))
          .map((tool) => {
            const entry: JsonObject = { name: tool.name };

            if (tool.description) {
              entry.description = tool.description;
            }

            if (tool.inputSchema !== undefined) {
              entry.inputSchema = tool.inputSchema;
            }

            return entry;
          });
      },
      inputSchema: { properties: {}, type: "object" },
    },
  }) satisfies ConnectorToolMap;

export const payloadAdminLink =
  (env: PayloadEnv) =>
  (collection: string, id: number | string): string =>
    payloadAdminUrl(env, collection, id);

export const payloadGlobalAdminLink =
  (env: PayloadEnv) =>
  (slug: string): string =>
    payloadGlobalAdminUrl(env, slug);

export const payloadSiteLink =
  (env: PayloadEnv) =>
  (link: string): string =>
    payloadSiteUrl(env, link);
