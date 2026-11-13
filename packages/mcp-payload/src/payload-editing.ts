import { ApplyConflictError, UpstreamRequestError } from "@patronage/mcp-core";
import type {
  JsonObject,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadMcpRequest, toPayloadToolResult } from "./payload";
import type { PayloadToolResult } from "./payload";

// The read-only tools apps/payload adds to Payload's MCP server
// (apps/payload/src/mcp-tools.ts).
export const DOCUMENT_LOCK_TOOL = "getDocumentLock";
export const EDITING_INFO_TOOL = "getEditingInfo";
export const MARKDOWN_TO_RICH_TEXT_TOOL = "markdownToRichText";
export const PREVIEW_URL_TOOL = "getPreviewUrl";
export const RICH_TEXT_TO_MARKDOWN_TOOL = "richTextToMarkdown";

// One call to a Payload MCP tool whose failure stops the operation: an
// unknown field, a conversion Payload refused, a tool the editor lacks.
export const callPayloadTool = async (
  client: UpstreamClient,
  name: string,
  args: JsonObject,
  telemetry: UpstreamTelemetry
): Promise<PayloadToolResult> => {
  const result = toPayloadToolResult(
    await payloadMcpRequest(
      client,
      "tools/call",
      { arguments: args, name },
      telemetry
    )
  );

  if (result.isError) {
    throw new ApplyConflictError(
      "payload_tool_failed",
      `Payload ${name}: ${result.text.slice(0, 200)}`
    );
  }

  return result;
};

// An array or blocks field: a list of rows. An array's rows all hold the same
// fields; a blocks field's rows hold the fields of their block type. Paths
// run from the document, or from the row that holds the field, and join
// groups with a dot (`hero.links`).
export interface RowsField {
  blocks?: BlockRows[] | undefined;
  // Array fields: the localized fields of one row, by path from the row.
  // Absent from a Payload whose `getEditingInfo` does not list them.
  localizedFields?: string[] | undefined;
  path: string;
  richTextFields?: string[] | undefined;
  rowFields?: RowsField[] | undefined;
  type: "array" | "blocks";
}

export interface BlockRows {
  // The localized fields of one row of this block, by path from the row.
  localizedFields?: string[] | undefined;
  richTextFields: string[];
  rowFields: RowsField[];
  slug: string;
}

const rowsFieldSchema: z.ZodType<RowsField> = z.lazy(() =>
  z.object({
    blocks: z
      .array(
        z.object({
          localizedFields: z.array(z.string()).optional(),
          richTextFields: z.array(z.string()),
          rowFields: z.array(rowsFieldSchema),
          slug: z.string(),
        })
      )
      .optional(),
    localizedFields: z.array(z.string()).optional(),
    path: z.string(),
    richTextFields: z.array(z.string()).optional(),
    rowFields: z.array(rowsFieldSchema).optional(),
    type: z.enum(["array", "blocks"]),
  })
);

const relationFieldSchema = z.object({
  hasMany: z.boolean(),
  path: z.string(),
  // Whether Payload stores each value as `{ relationTo, value }`. Absent
  // from a Payload whose `getEditingInfo` does not say; a field that names
  // more than one collection is always stored that way.
  polymorphic: z.boolean().optional(),
  relationTo: z.array(z.string()),
});

const uploadSchema = z.object({
  maxFileSize: z.number().nullable(),
  mimeTypes: z.array(z.string()),
  urlAllowList: z
    .array(
      z.object({
        hostname: z.string(),
        pathname: z.string().optional(),
        port: z.string().optional(),
        protocol: z.string().optional(),
        search: z.string().optional(),
      })
    )
    .nullable(),
  versions: z.boolean(),
});

// The first `getEditingInfo` reported five fields per collection and nothing
// else. Everything added since has a default, so a site whose Payload still
// runs the first version reads as one with no rows, uploads, globals or
// locales to write to, rather than failing.
const collectionEditingSchema = z.object({
  autosave: z.boolean().default(false),
  canCreate: z.boolean(),
  canDelete: z.boolean().default(false),
  canUpdate: z.boolean(),
  drafts: z.boolean(),
  localized: z.boolean().default(false),
  // The localized fields outside any row, by path; a field under one of
  // them is localized with it, and every other field is shared by all
  // locales. `_status` is among them where the collection keeps a status
  // for each locale. Absent from a Payload that does not list them, and
  // then an operation cannot name a locale.
  localizedFields: z.array(z.string()).optional(),
  preview: z.boolean().default(false),
  relationFields: z.array(relationFieldSchema).default([]),
  richTextFields: z.array(z.string()),
  rowFields: z.array(rowsFieldSchema).default([]),
  schedulePublish: z.boolean().default(false),
  slug: z.string(),
  titleField: z.string().optional(),
  trash: z.boolean().default(false),
  upload: uploadSchema.optional(),
});

const globalEditingSchema = z.object({
  canUpdate: z.boolean(),
  drafts: z.boolean(),
  localized: z.boolean().default(false),
  // As for a collection.
  localizedFields: z.array(z.string()).optional(),
  // Whether another editor has the global open in the admin. Absent from a
  // Payload whose `getEditingInfo` does not report it, and then a global is
  // not written to: Payload itself saves a global over an editor's lock.
  locked: z.boolean().optional(),
  relationFields: z.array(relationFieldSchema).default([]),
  richTextFields: z.array(z.string()),
  rowFields: z.array(rowsFieldSchema).default([]),
  slug: z.string(),
});

const localizationSchema = z.object({
  defaultLocale: z.string(),
  locales: z.array(z.string()),
});

export const editingInfoSchema = z.object({
  collections: z.array(collectionEditingSchema),
  globals: z.array(globalEditingSchema).default([]),
  localization: localizationSchema.nullable().default(null),
});

export type CollectionEditing = z.infer<typeof collectionEditingSchema>;

export type UploadEditing = z.infer<typeof uploadSchema>;

export type GlobalEditing = z.infer<typeof globalEditingSchema>;

export type EditingInfo = z.infer<typeof editingInfoSchema>;

// What this editor can write to, as Payload describes it: the collections
// and globals MCP may see, which keep drafts, which fields take Markdown or
// hold rows, what an upload collection accepts, and the site's locales.
export const readEditingInfo = async (
  client: UpstreamClient,
  telemetry: UpstreamTelemetry
): Promise<EditingInfo> => {
  const result = await callPayloadTool(
    client,
    EDITING_INFO_TOOL,
    {},
    telemetry
  );

  const parsed = editingInfoSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new UpstreamRequestError("Payload returned invalid editing info");
  }

  return parsed.data;
};

// `path` came after `url`: a Payload that still answers with the link alone
// reads as one that knows no public path.
const previewUrlSchema = z.object({
  path: z.string().nullable().default(null),
  url: z.string().nullable(),
});

/** Where the front end shows one document. */
export interface DocumentAddress {
  // The public path it is served at once published, such as `/news/hello`.
  path?: string;
  // The link the admin's Preview button opens: its draft preview.
  url?: string;
}

// Where the front end shows one document, as Payload says: the link the
// admin's Preview button opens (usually a path on the site itself) and the
// document's public path. Never a reason to stop a write, so every failure
// reads as "no address".
export const readDocumentAddress = async (
  client: UpstreamClient,
  collection: string,
  id: number | string,
  telemetry: UpstreamTelemetry
): Promise<DocumentAddress> => {
  const address: DocumentAddress = {};

  try {
    const result = await callPayloadTool(
      client,
      PREVIEW_URL_TOOL,
      { id, slug: collection },
      telemetry
    );

    const parsed = previewUrlSchema.safeParse(result.structured);

    if (parsed.success && parsed.data.url) {
      address.url = parsed.data.url;
    }

    if (parsed.success && parsed.data.path) {
      address.path = parsed.data.path;
    }
  } catch {
    // No address.
  }

  return address;
};

export const readPreviewUrl = async (
  client: UpstreamClient,
  collection: string,
  id: number | string,
  telemetry: UpstreamTelemetry
): Promise<string | undefined> => {
  const address = await readDocumentAddress(client, collection, id, telemetry);

  return address.url;
};

const documentLockSchema = z.object({ locked: z.boolean() });

// Whether another editor has the document open in the admin. Payload makes
// this check itself before an ordinary save, and answers 423; a write it
// makes regardless (restoring a version) is asked about here first.
// Undefined when the site's Payload has no such tool or it fails: then the
// caller cannot tell, and does not write.
export const readDocumentLock = async (
  client: UpstreamClient,
  collection: string,
  id: number | string,
  telemetry: UpstreamTelemetry
): Promise<boolean | undefined> => {
  try {
    const result = toPayloadToolResult(
      await payloadMcpRequest(
        client,
        "tools/call",
        { arguments: { id, slug: collection }, name: DOCUMENT_LOCK_TOOL },
        telemetry
      )
    );

    const parsed = documentLockSchema.safeParse(result.structured);

    return !result.isError && parsed.success ? parsed.data.locked : undefined;
  } catch {
    return undefined;
  }
};
