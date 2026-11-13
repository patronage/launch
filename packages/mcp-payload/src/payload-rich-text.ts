import { ApplyConflictError, UpstreamRequestError } from "@patronage/mcp-core";
import type {
  JsonObject,
  JsonValue,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import {
  callPayloadTool,
  MARKDOWN_TO_RICH_TEXT_TOOL,
  RICH_TEXT_TO_MARKDOWN_TOOL,
} from "./payload-editing";

// Rich text as Markdown, both ways. Payload does the converting, with the
// field's own editor features, through the two read-only tools apps/payload
// adds; only Payload knows which Lexical features a field has.

const recordSchema = z.record(z.string(), z.json());

const markdownResultSchema = z.object({
  lost: z.array(z.string()).default([]),
  markdown: z.string(),
});

const richTextResultSchema = z.object({ value: recordSchema });

/**
 * Which rich text field a conversion is for. `field` is a top-level field's
 * name. A field inside a row also gives `path`: the field names from the
 * document down to it, with a block's slug after each blocks field, such as
 * `["layout", "content", "body"]`.
 */
export interface RichTextTarget {
  collection: string;
  field: string;
  path?: string[] | undefined;
}

const toolArgs = (target: RichTextTarget): JsonObject => {
  const args: JsonObject = { field: target.field, slug: target.collection };

  if (target.path) {
    args.path = target.path;
  }

  return args;
};

const named = (target: RichTextTarget): string =>
  target.path ? target.path.join(".") : target.field;

export const toRichText = async (
  client: UpstreamClient,
  target: RichTextTarget,
  markdown: string,
  telemetry: UpstreamTelemetry
): Promise<JsonObject> => {
  const result = await callPayloadTool(
    client,
    MARKDOWN_TO_RICH_TEXT_TOOL,
    { ...toolArgs(target), markdown },
    telemetry
  );

  const parsed = richTextResultSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new UpstreamRequestError(
      `Payload returned no rich text for ${named(target)}`
    );
  }

  return parsed.data.value;
};

const convertToMarkdown = async (
  client: UpstreamClient,
  target: RichTextTarget,
  value: JsonValue | undefined,
  telemetry: UpstreamTelemetry
): Promise<z.infer<typeof markdownResultSchema>> => {
  const stored = recordSchema.safeParse(value);

  if (!stored.success) {
    return { lost: [], markdown: "" };
  }

  const result = await callPayloadTool(
    client,
    RICH_TEXT_TO_MARKDOWN_TOOL,
    { ...toolArgs(target), value: stored.data },
    telemetry
  );

  const parsed = markdownResultSchema.safeParse(result.structured);

  if (!parsed.success) {
    throw new UpstreamRequestError(
      `Payload returned no Markdown for ${named(target)}`
    );
  }

  return parsed.data;
};

export const toMarkdown = async (
  client: UpstreamClient,
  target: RichTextTarget,
  value: JsonValue | undefined,
  telemetry: UpstreamTelemetry
): Promise<string> => {
  const converted = await convertToMarkdown(client, target, value, telemetry);

  // Writing Markdown back would turn these nodes into plain text, deleting
  // them while the Markdown preview hides what they held.
  if (converted.lost.length > 0) {
    throw new ApplyConflictError(
      "markdown_would_lose_content",
      `${target.collection} ${named(target)} holds ${converted.lost.join(", ")} nodes that Markdown cannot carry; change it in fields as Lexical JSON, or in the Payload admin`
    );
  }

  return converted.markdown;
};

/**
 * Rich text as Markdown for reading only, where nothing is written back
 * from it: nodes Markdown cannot carry come out as Payload's placeholders
 * instead of stopping the conversion.
 */
export const readableMarkdown = async (
  client: UpstreamClient,
  target: RichTextTarget,
  value: JsonValue | undefined,
  telemetry: UpstreamTelemetry
): Promise<string> => {
  const converted = await convertToMarkdown(client, target, value, telemetry);

  return converted.markdown;
};
