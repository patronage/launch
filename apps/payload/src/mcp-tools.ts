import {
  defineCollectionTool,
  defineGlobalTool,
  defineTool,
} from "@payloadcms/plugin-mcp";
import {
  convertLexicalToMarkdown,
  convertMarkdownToLexical,
  editorConfigFactory,
} from "@payloadcms/richtext-lexical";
import type { SerializedEditorState } from "@payloadcms/richtext-lexical/lexical";
import { getAccessResults } from "payload";
import type {
  CollectionSlug,
  FlattenedBlock,
  GlobalSlug,
  PayloadRequest,
  RichTextField,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
  Where,
} from "payload";
import { z } from "zod";

import { DEFAULT_LOCK_SECONDS, heldByAnother } from "./lib/document-lock";
import { describeDocumentFields, findFieldByPath } from "./lib/editing-info";
import type { BlockLookup } from "./lib/editing-info";
import { publicPathOf } from "./lib/preview";

// Read-only tools for the MCP gateway (apps/mcp). Two convert rich text, so
// an agent can write Markdown and the person approving it reads Markdown too.
// They run here, against the field's own editor config, because only Payload
// knows which Lexical features a field has. `getEditingInfo` tells the
// gateway which collections keep drafts. None of them reads or writes a
// document: the gateway saves changes through its approval step.
// `getPreviewUrl` reads one document, as the editor, to give the link the
// admin's Preview button opens, `findGlobalDraft` reads a global's newest
// version, which Payload's own `findGlobal` tool cannot ask for, and
// `getDocumentLock` says whether another editor has a document open.

const MAX_MARKDOWN_LENGTH = 200_000;

const fieldName = z
  .string()
  .min(1)
  .max(64)
  .describe("The name of a top-level rich text field in the collection.");

const MAX_SCHEMA_PATH = 16;

const schemaPath = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(MAX_SCHEMA_PATH)
  .optional()
  .describe(
    'For a rich text field inside a row or a group: the field names from the document down to it, with a block\'s slug after each blocks field, such as ["layout", "content", "body"]. Leave out for a top-level field.'
  );

const markdownInputSchema = z.object({
  field: fieldName,
  markdown: z.string().max(MAX_MARKDOWN_LENGTH),
  path: schemaPath,
});

const lexicalTreeNode = z.object({
  children: z.array(z.unknown()).optional(),
  type: z.string(),
});

const lexicalNode = z.object({ type: z.string(), version: z.number() }).loose();

const richTextInputSchema = z.object({
  field: fieldName,
  path: schemaPath,
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

// Every node type in a Lexical tree, depth first.
const nodeTypes = (nodes: readonly unknown[]): string[] =>
  nodes.flatMap((node) => {
    const parsed = lexicalTreeNode.safeParse(node);

    if (!parsed.success) {
      return [];
    }

    return [parsed.data.type, ...nodeTypes(parsed.data.children ?? [])];
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

// Blocks a field names by slug live in the config's own `blocks` list.
const blockLookup = (req: PayloadRequest): BlockLookup => {
  const blocks = new Map<string, FlattenedBlock>(
    Object.entries(req.payload.blocks)
  );

  return (slug) => blocks.get(slug);
};

// The field a conversion is for: a top-level one by name, or one inside a
// row or a group by its schema path. Each has its own editor features.
const richTextField = (
  req: PayloadRequest,
  slug: CollectionSlug,
  target: { field: string; path?: string[] | undefined }
): RichTextField | undefined => {
  if (!target.path) {
    return richTextFields(req, slug).find(
      (field) => field.name === target.field
    );
  }

  const found = findFieldByPath(
    req.payload.collections[slug]?.config.flattenedFields ?? [],
    target.path,
    blockLookup(req)
  );

  return found && isRichText(found) ? found : undefined;
};

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
  const field = richTextField(req, slug, input);

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
    "Convert a rich text field's Lexical JSON into Markdown, using that field's editor features. `lost` names node types (blocks, uploads) that Markdown cannot carry back. Reads and writes nothing.",
  input: richTextInputSchema,
}).handler(({ input, req, slug }) => {
  const field = richTextField(req, slug, input);

  if (!field) {
    return errorResult(`No rich text field by that name in ${slug}`);
  }

  // SAFETY: the input schema checked the root node's fields and the `type`
  // and `version` every child has; the converter skips node types it lacks.
  const data = input.value as SerializedEditorState;

  const editorConfig = editorConfigFactory.fromField({ field });
  const markdown = convertLexicalToMarkdown({ data, editorConfig });

  // Markdown carries only what the field's Markdown transformers know.
  // Blocks, uploads and the like come out as placeholders and would turn
  // into plain text on the way back, so the node types that do not survive
  // the round trip are named, and the gateway refuses a Markdown edit then.
  const roundTrip = convertMarkdownToLexical({ editorConfig, markdown });
  const kept = new Set(nodeTypes(roundTrip.root.children));

  const lost = [
    ...new Set(nodeTypes(data.root.children).filter((type) => !kept.has(type))),
  ].toSorted();

  return {
    ...textResult(markdown),
    structuredContent: { lost, markdown },
  };
});

const documentId = z.union([
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u),
]);

type PreviewLink = NonNullable<SanitizedCollectionConfig["admin"]["preview"]>;

const statusSchema = z.object({ _status: z.string() });

interface Addressed {
  id: number | string;
  preview: PreviewLink;
  slug: CollectionSlug;
}

// One reading of the document, as this editor, and the link the admin's
// Preview button would make for it.
const previewLinkOf = async (
  req: PayloadRequest,
  target: Addressed,
  draft: boolean
): Promise<{ status: string | undefined; url: string | null } | undefined> => {
  const doc = await req.payload.findByID({
    collection: target.slug,
    depth: 0,
    disableErrors: true,
    draft,
    id: target.id,
    overrideAccess: false,
    req,
  });

  if (!doc) {
    return undefined;
  }

  const status = statusSchema.safeParse(doc);

  const url =
    (await target.preview(
      { ...doc },
      { locale: req.locale ?? "", req, token: null }
    )) ?? null;

  return { status: status.success ? status.data._status : undefined, url };
};

// Where the public reaches the document now: the address of the document
// itself, which is its published version. A newer draft can carry another
// slug, and that is where the document would be served once the draft is
// published, not where it is today. Null while it is not published.
const publicPath = async (
  req: PayloadRequest,
  target: Addressed
): Promise<string | null> => {
  const published = await previewLinkOf(req, target, false);

  // A collection without drafts has no status: every document is public.
  return published && (published.status ?? "published") === "published"
    ? publicPathOf(published.url)
    : null;
};

export const getPreviewUrl = defineCollectionTool({
  access: readPermission,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Get preview link",
  },
  description:
    "The front end's draft preview link for one document, as the admin's Preview button opens it (`url`, null when the document has no address yet), and the path the public reaches the document at now (`path`, from its published version; null while it is not published). Writes nothing.",
  input: z.object({ id: documentId }),
}).handler(async ({ input, req, slug }) => {
  const preview = req.payload.collections[slug]?.config.admin.preview;

  if (!preview) {
    return errorResult(`${slug} has no preview link`);
  }

  const target = { id: input.id, preview, slug };

  // Newest version first, the way the admin does.
  const newest = await previewLinkOf(req, target, true);

  if (!newest) {
    return errorResult(`${slug}/${input.id} was not found`);
  }

  return {
    ...textResult(newest.url ?? ""),
    structuredContent: { path: await publicPath(req, target), url: newest.url },
  };
});

// Payload refuses to save a document another editor has open, but restores
// a version of it regardless and removes their lock. The gateway asks here
// before it restores one.
export const getDocumentLock = defineCollectionTool({
  access: readPermission,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Get document lock",
  },
  description:
    "Whether another editor has one document open in the admin right now (`locked`). Reads nothing of the document and writes nothing.",
  input: z.object({ id: documentId }),
}).handler(async ({ input, req, slug }) => {
  const locked = await lockedByAnother(req, {
    setting: req.payload.collections[slug]?.config.lockDocuments,
    where: {
      and: [
        { "document.relationTo": { equals: slug } },
        { "document.value": { equals: input.id } },
      ],
    },
  });

  return {
    ...textResult(locked ? "locked" : "not locked"),
    structuredContent: { locked },
  };
});

const MAX_DEPTH = 3;

// Payload's own `findGlobal` tool reads the published global only. Where a
// global keeps drafts, an edit starts from its newest version, as the admin
// does, and that version's `updatedAt` is the one a write is checked against.
export const findGlobalDraft = defineGlobalTool({
  access: ({ permissions, req, slug }) =>
    Boolean(req.user && permissions?.globals?.[slug]?.read),
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Find global draft",
  },
  description:
    "Read a global as the admin opens it: its newest version, which is a draft where one is newer than what is published. A global without drafts reads as it is. Writes nothing.",
  input: z.object({
    depth: z.number().int().min(0).max(MAX_DEPTH).default(0),
  }),
}).handler(async ({ input, req, slug }) => {
  const doc = await req.payload.findGlobal({
    depth: input.depth,
    draft: true,
    overrideAccess: false,
    req,
    slug,
  });

  return {
    ...textResult(JSON.stringify(doc)),
    structuredContent: { doc },
  };
});

// A draft setting is `false` or an options object; only whether it is on
// matters to the gateway.
const draftSettings = (
  versions: SanitizedCollectionConfig["versions"] | undefined
) => {
  const drafts = versions ? versions.drafts : false;

  return {
    autosave: Boolean(drafts && drafts.autosave),
    drafts: Boolean(drafts),
    schedulePublish: Boolean(drafts && drafts.schedulePublish),
  };
};

interface AllowedHost {
  hostname: string;
  pathname?: string;
  port?: string;
  protocol?: string;
  search?: string;
}

// An allow-list entry as Payload matches a URL against it, without the keys
// it leaves unset.
const allowedHost = (entry: AllowedHost): AllowedHost => {
  const host: AllowedHost = { hostname: entry.hostname };

  if (entry.pathname !== undefined) {
    host.pathname = entry.pathname;
  }

  if (entry.port !== undefined) {
    host.port = entry.port;
  }

  if (entry.protocol !== undefined) {
    host.protocol = entry.protocol;
  }

  if (entry.search !== undefined) {
    host.search = entry.search;
  }

  return host;
};

// What an upload collection accepts. `urlAllowList` is the hosts Payload
// itself would fetch a pasted URL from; null means it fetches from none.
const uploadInfo = (req: PayloadRequest, config: SanitizedCollectionConfig) => {
  if (!config.upload) {
    return;
  }

  const paste = config.upload.pasteURL;

  return {
    maxFileSize: req.payload.config.upload.limits?.fileSize ?? null,
    mimeTypes: config.upload.mimeTypes ?? [],
    urlAllowList:
      paste && paste.allowList.length > 0
        ? paste.allowList.map((entry) => allowedHost(entry))
        : null,
    // Whether the collection keeps versions, which decides what a file
    // replacement can say about the file it replaces.
    versions: Boolean(config.versions),
  };
};

const localizationInfo = (req: PayloadRequest) => {
  const { localization } = req.payload.config;

  return localization
    ? {
        defaultLocale: localization.defaultLocale,
        locales: localization.localeCodes,
      }
    : null;
};

type AccessResults = Awaited<ReturnType<typeof getAccessResults>>;

const collectionInfo = (
  req: PayloadRequest,
  access: AccessResults,
  slug: CollectionSlug
) => {
  const permissions = access.collections?.[slug];
  const config = req.payload.collections[slug]?.config;

  if (!(permissions?.read && config)) {
    return [];
  }

  const fields = describeDocumentFields(
    config.flattenedFields,
    blockLookup(req)
  );

  return [
    {
      ...draftSettings(config.versions),
      canCreate: Boolean(permissions.create),
      canDelete: Boolean(permissions.delete),
      canUpdate: Boolean(permissions.update),
      localized: fields.localized,
      preview: Boolean(config.admin.preview),
      relationFields: fields.relationFields,
      richTextFields: richTextFields(req, slug).map((field) => field.name),
      rowFields: fields.rowFields,
      slug,
      titleField: config.admin.useAsTitle,
      trash: Boolean(config.trash),
      // Absent for a collection that holds no files; JSON drops the key.
      upload: uploadInfo(req, config),
    },
  ];
};

const LOCKS = "payload-locked-documents";

// Whether another editor has a document or a global open in the admin, from
// Payload's own lock documents. They are read past access control, as
// Payload reads them, and only this one fact about them is reported.
const lockedByAnother = async (
  req: PayloadRequest,
  lock: {
    setting: SanitizedGlobalConfig["lockDocuments"];
    where: Where;
  }
): Promise<boolean> => {
  if (lock.setting === false || !req.payload.collections[LOCKS]) {
    return false;
  }

  const found = await req.payload.find({
    collection: LOCKS,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    sort: "-updatedAt",
    where: lock.where,
  });

  const [held] = found.docs;

  return held
    ? heldByAnother(held, {
        now: Date.now(),
        seconds: lock.setting?.duration ?? DEFAULT_LOCK_SECONDS,
        userId: req.user?.id,
      })
    : false;
};

const globalInfo = async (
  req: PayloadRequest,
  access: AccessResults,
  slug: GlobalSlug
) => {
  const permissions = access.globals?.[slug];

  const config = req.payload.globals.config.find(
    (global) => global.slug === slug
  );

  if (!(permissions?.read && config)) {
    return [];
  }

  const fields = describeDocumentFields(
    config.flattenedFields,
    blockLookup(req)
  );

  return [
    {
      canUpdate: Boolean(permissions.update),
      drafts: Boolean(config.versions && config.versions.drafts),
      localized: fields.localized,
      // True while another editor has the global open in the admin. Payload
      // makes this check itself before it saves a collection document, but
      // not before it saves a global, so the gateway asks here first.
      locked: await lockedByAnother(req, {
        setting: config.lockDocuments,
        where: { globalSlug: { equals: config.slug } },
      }),
      relationFields: fields.relationFields,
      // Top-level only, as for a collection: the fields Markdown can fill.
      richTextFields: fields.richTextFields.filter(
        (path) => !path.includes(".")
      ),
      rowFields: fields.rowFields,
      slug,
    },
  ];
};

// What the gateway needs before it writes: whether a collection keeps drafts
// (without them a "draft" would publish at once), which fields take Markdown,
// which hold rows, what an upload collection accepts, and what this editor
// may do, and whether another editor has a global open. Only the collections
// and globals passed in are described, so those hidden from MCP stay hidden
// here too. The first version reported
// `canCreate`, `canUpdate`, `drafts`, `richTextFields` and `slug` for each
// collection; those keep their meaning, so an older gateway reads this one.
export const getEditingInfo = (
  slugs: readonly CollectionSlug[],
  globalSlugs: readonly GlobalSlug[] = []
) =>
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
      "List the collections and globals this editor can read: whether each keeps drafts, which fields are rich text, which are arrays or blocks and what their rows hold, what an upload collection accepts, the site's locales, what the editor may create, update or delete, and whether another editor has a global open.",
    input: z.object({}),
  }).handler(async ({ req }) => {
    const access = await getAccessResults({ req });

    const globals = await Promise.all(
      globalSlugs.map((slug) => globalInfo(req, access, slug))
    );

    const info = {
      collections: slugs.flatMap((slug) => collectionInfo(req, access, slug)),
      globals: globals.flat(),
      localization: localizationInfo(req),
    };

    return {
      ...textResult(JSON.stringify(info)),
      structuredContent: info,
    };
  });
