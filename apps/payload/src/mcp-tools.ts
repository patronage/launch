import { defineCollectionTool, defineTool } from "@payloadcms/plugin-mcp";
import {
  convertLexicalToMarkdown,
  convertMarkdownToLexical,
  editorConfigFactory,
} from "@payloadcms/richtext-lexical";
import type { SerializedEditorState } from "@payloadcms/richtext-lexical/lexical";
import { getAccessResults } from "payload";
import type { CollectionSlug, PayloadRequest, RichTextField } from "payload";
import { z } from "zod";

// Read-only tools for the MCP gateway (apps/mcp). Two convert rich text, so
// an agent can write Markdown and the person approving it reads Markdown too.
// They run here, against the field's own editor config, because only Payload
// knows which Lexical features a field has. `getEditingInfo` tells the
// gateway which collections keep drafts. None of them reads or writes a
// document: the gateway saves changes through its approval step.

const MAX_MARKDOWN_LENGTH = 200_000;

const fieldName = z
  .string()
  .min(1)
  .max(64)
  .describe("The name of a top-level rich text field in the collection.");

const markdownInputSchema = z.object({
  field: fieldName,
  markdown: z.string().max(MAX_MARKDOWN_LENGTH),
});

const lexicalNode = z.object({ type: z.string(), version: z.number() }).loose();

const richTextInputSchema = z.object({
  field: fieldName,
  value: z
    .object({
      root: z
        .object({
          children: z.array(lexicalNode),
          direction: z.enum(["ltr", "rtl"]).nullable(),
          format: z.enum([
            "",
            "center",
            "end",
            "justify",
            "left",
            "right",
            "start",
          ]),
          indent: z.number(),
          type: z.literal("root"),
          version: z.number(),
        })
        .loose(),
    })
    .loose()
    .describe("The field's stored Lexical value, with its `root`."),
});

const textResult = (text: string) => ({
  content: [{ text, type: "text" as const }],
});

const errorResult = (text: string) => ({
  content: [{ text, type: "text" as const }],
  isError: true,
});

const isRichText = (field: { type: string }): field is RichTextField =>
  field.type === "richText";

// Only a rich text field whose value sits at the top of the document (unnamed
// tabs and rows flatten into it): the gateway writes top-level fields.
const richTextFields = (
  req: PayloadRequest,
  slug: CollectionSlug
): RichTextField[] =>
  (req.payload.collections[slug]?.config.flattenedFields ?? []).filter(
    isRichText
  );

const richTextField = (
  req: PayloadRequest,
  slug: CollectionSlug,
  name: string
): RichTextField | undefined =>
  richTextFields(req, slug).find((field) => field.name === name);

const readPermission = ({
  permissions,
  req,
  slug,
}: {
  permissions?: { collections?: Record<string, { read?: unknown }> };
  req: PayloadRequest;
  slug: CollectionSlug;
}) => Boolean(req.user && permissions?.collections?.[slug]?.read);

export const markdownToRichText = defineCollectionTool({
  access: readPermission,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Markdown to rich text",
  },
  description:
    "Convert Markdown into the Lexical JSON a rich text field stores, using that field's editor features. Reads and writes nothing.",
  input: markdownInputSchema,
}).handler(({ input, req, slug }) => {
  const field = richTextField(req, slug, input.field);

  if (!field) {
    return errorResult(`No rich text field by that name in ${slug}`);
  }

  const value = convertMarkdownToLexical({
    editorConfig: editorConfigFactory.fromField({ field }),
    markdown: input.markdown,
  });

  return {
    ...textResult(JSON.stringify(value)),
    structuredContent: { value },
  };
});

export const richTextToMarkdown = defineCollectionTool({
  access: readPermission,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Rich text to Markdown",
  },
  description:
    "Convert a rich text field's Lexical JSON into Markdown, using that field's editor features. Reads and writes nothing.",
  input: richTextInputSchema,
}).handler(({ input, req, slug }) => {
  const field = richTextField(req, slug, input.field);

  if (!field) {
    return errorResult(`No rich text field by that name in ${slug}`);
  }

  // SAFETY: the input schema checked the root node's fields and the `type`
  // and `version` every child has; the converter skips node types it lacks.
  const data = input.value as SerializedEditorState;

  const markdown = convertLexicalToMarkdown({
    data,
    editorConfig: editorConfigFactory.fromField({ field }),
  });

  return { ...textResult(markdown), structuredContent: { markdown } };
});

// What the gateway needs before it writes: whether a collection keeps drafts
// (without them a "draft" would publish at once), which fields take Markdown,
// and what this editor may do. Only the collections passed in are described,
// so collections hidden from MCP stay hidden here too.
export const getEditingInfo = (slugs: readonly CollectionSlug[]) =>
  defineTool({
    access: ({ req }) => Boolean(req.user),
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
      title: "Get editing info",
    },
    description:
      "List the collections this editor can read, with whether each keeps drafts, which top-level fields are rich text, and whether the editor may create or update there.",
    input: z.object({}),
  }).handler(async ({ req }) => {
    const access = await getAccessResults({ req });

    const collections = slugs.flatMap((slug) => {
      const permissions = access.collections?.[slug];

      if (!permissions?.read) {
        return [];
      }

      const versions = req.payload.collections[slug]?.config.versions;

      return [
        {
          canCreate: Boolean(permissions.create),
          canUpdate: Boolean(permissions.update),
          drafts: Boolean(versions && versions.drafts),
          richTextFields: richTextFields(req, slug).map((field) => field.name),
          slug,
        },
      ];
    });

    return {
      ...textResult(JSON.stringify({ collections })),
      structuredContent: { collections },
    };
  });
