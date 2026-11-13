import type { GatewayConnector } from "@patronage/mcp-core";

import type { PayloadEnv } from "./env";
import { createPayloadClient, payloadConfigured } from "./payload";
import { preflightDraftOperations } from "./payload-apply";
import { readEditingInfo } from "./payload-editing";
import { operationSentence, parseDraftApplyInput } from "./payload-operations";
import {
  createPayloadTools,
  payloadAdminLink,
  payloadGlobalAdminLink,
  payloadSiteLink,
  PAYLOAD_CONNECTOR_INSTRUCTIONS,
} from "./payload-tools";

const PAYLOAD_EXECUTE_DESCRIPTION = [
  "The payload global reaches the Payload CMS.",
  'Payload reads: await payload.tools() lists the read tools; await payload.call({ tool: "findDocuments", arguments: { slug: "posts", where: { slug: { equals: "hello" } }, draft: true } }) returns { isError, text, structured? } with the documents as JSON in text.',
  'Payload writes: await payload.apply({ intent, operations }), with 1-20 operations shaped { kind: "update_draft", collection, id, fields?, markdown?, publish?, expected_updated_at? } or { kind: "create_draft", collection, fields?, markdown?, publish? }; each is saved as a draft after human approval, and published only when it sets publish: true, which you add only when the person asked to publish. Put rich text fields in markdown as Markdown text; describe_site lists them under payload.collections[].richTextFields. Copy updatedAt from a draft: true read into expected_updated_at.',
  'Payload rows: to change one section, card or link without resending the whole field, payload.apply { kind: "patch_rows", collection, id, expected_updated_at, changes }, where each change is { op: "set", path, value }, { op: "set_markdown", path, markdown }, { op: "insert", field, after_id, row }, { op: "remove", field, row_id } or { op: "move", field, row_id, after_id }. A path names rows by id: layout[id=<row id>].cards[id=<row id>].title. Read the document with draft: true and depth: 0 for the row ids; describe_site lists the array and blocks fields under payload.collections[].rowFields.',
  'Payload globals: payload.apply { kind: "update_global", global, expected_updated_at, fields?, changes?, publish? } changes a global such as the site settings; changes takes the row changes of patch_rows. Read it with payload.call({tool: "findGlobalDraft", arguments: {slug, depth: 0}}) for its newest version and updatedAt. describe_site lists them under payload.globals[] with drafts and locked: a global without drafts is live as soon as it is saved, so the operation must say publish: true, which you add only when the person asked for that; a global another editor has open (locked: true) is refused until they finish.',
  'Payload unpublish: payload.apply { kind: "unpublish", collection, id, expected_updated_at } takes a published document off the public site and keeps its content as a draft; send it only when the person asked to unpublish. Its page stops being served as soon as it is approved. To publish a document again, send { kind: "update_draft", collection, id, publish: true } with no fields.',
  'Payload versions: payload.apply { kind: "restore_version", collection, id, version_id, expected_updated_at, publish? } brings back an earlier version of a document as a new draft (published only with publish: true); { kind: "restore_global_version", global, version_id, expected_updated_at, publish? } does the same for a global. Find versions with payload.call({ tool: "findVersions", arguments: { slug, where: { parent: { equals: id } }, sort: "-updatedAt", depth: 0 } }).',
  'Payload trash: payload.apply { kind: "trash", collection, id, expected_updated_at } moves a document to the trash (collections with trash: true in describe_site only; never an upload collection), and a published page stops being served as soon as it is approved; send it only when the person asked. { kind: "restore_from_trash", collection, id, expected_updated_at, publish? } takes it back out as a draft, or published with publish: true. Read trashed documents with payload.call({ tool: "findDocuments", arguments: { slug, trash: true, draft: true, where: { deletedAt: { exists: true } } } }). Nothing is deleted for good.',
  'Payload locales: where describe_site lists payload.localization, add locale: "<code>" to update_draft, create_draft, patch_rows, update_global, upload_media, replace_media_file or unpublish to write that locale (the default locale without it), and read it first with locale and fallbackLocale: "none" on the read tools. Fields outside localizedFields are shared by every locale. publish: true publishes the operation\'s locale only; publish_all_locales: true publishes every locale, only when the person asked for that.',
  'Payload files: const file = await payload.stageUpload({ collection: "media", source: { url } }) for a URL the collection allows, or source: { base64, filename, mimeType } for a very small file (the script is at most 20,000 characters, so about 14 KB of file), keeps the file in the gateway and returns { upload_ref, filename, mimeType, bytes }. Then payload.apply { kind: "upload_media", collection, upload_ref, fields? } for a new file, or { kind: "replace_media_file", collection, id, upload_ref, expected_updated_at, fields? } to replace an existing one, which shows at once wherever the file is used.',
].join(" ");

// The Payload connector: Payload's own read tools over its MCP endpoint, and
// draft writes through the approval step.
export const payloadConnector: GatewayConnector<PayloadEnv> = {
  configured: payloadConfigured,
  // The collections and globals this editor can read: which keep drafts,
  // which fields take Markdown or hold rows, what an upload collection
  // accepts, and the site's locales.
  describe: async (env, caller, telemetry) => {
    const info = await readEditingInfo(
      createPayloadClient(env, caller),
      telemetry
    );

    // Parsed and passed on whole; `describe_site` bounds what a text-only
    // client is shown.
    return {
      collections: info.collections,
      globals: info.globals,
      localization: info.localization,
    };
  },
  executeDescription: PAYLOAD_EXECUTE_DESCRIPTION,
  instructions: PAYLOAD_CONNECTOR_INSTRUCTIONS,
  name: "payload",
  parseApply: (args) => {
    const input = parseDraftApplyInput(args);

    return {
      intent: input.intent,
      sentences: input.operations.map((operation) =>
        operationSentence(operation)
      ),
    };
  },
  preflight: (env, caller, args, telemetry, context) => {
    const input = parseDraftApplyInput(args);

    return preflightDraftOperations(
      createPayloadClient(env, caller),
      input.intent,
      input.operations,
      payloadAdminLink(env),
      telemetry,
      {
        // The run's staged files, which an upload's preview shows.
        files: context && { ...context, images: env.IMAGES },
        globalAdminUrl: payloadGlobalAdminLink(env),
        siteUrl: payloadSiteLink(env),
      }
    );
  },
  tools: createPayloadTools,
};
