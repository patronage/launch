import {
  ApplyValidationError,
  MAX_OPERATIONS,
  joinPhrase,
} from "@patronage/mcp-core";
import type { JsonValue } from "@patronage/mcp-core";
import { z } from "zod";

import {
  MAX_PATH_LENGTH,
  parseRowFieldPath,
  parseRowsFieldPath,
  ROW_ID,
} from "./payload-row-paths";

// What `payload.apply` can change. The draft kinds change top-level fields of
// one document, saved as a new draft of it or as a new draft document; the
// upload kinds (further down) add a file or replace one. A change is published only
// when its operation says `publish: true`, which the approval preview shows
// as its own `_status` row. The fields Payload manages itself are refused in
// `fields`: the id, the timestamps, and every `_`-prefixed key, so `_status`
// changes only through `publish`.
const RESERVED_FIELDS = new Set(["createdAt", "deletedAt", "id", "updatedAt"]);

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/u);

const fieldNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u)
  .refine((name) => !RESERVED_FIELDS.has(name), {
    message: "Payload manages this field itself",
  });

const documentIdSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u),
]);

// The longest Markdown one rich text field takes, matching Payload's own
// `markdownToRichText` bound (apps/payload/src/mcp-tools.ts).
export const MAX_MARKDOWN_LENGTH = 200_000;

interface DraftChanges {
  fields?: Record<string, JsonValue> | undefined;
  markdown?: Record<string, string> | undefined;
  publish?: true | undefined;
}

// The field Payload keeps a document's draft or published state in.
export const STATUS_FIELD = "_status";

export const draftFields = (
  operation: DraftChanges
): Record<string, JsonValue> => operation.fields ?? {};

export const draftMarkdown = (
  operation: DraftChanges
): Record<string, string> => operation.markdown ?? {};

const fieldKeys = (operation: DraftChanges): string[] => {
  const fields = draftFields(operation);

  return [
    ...Object.keys(fields).filter((key) => fields[key] !== undefined),
    ...Object.keys(draftMarkdown(operation)),
  ].toSorted();
};

// Fields and Markdown together: `fields` holds stored values as Payload keeps
// them, `markdown` holds rich text fields written as Markdown, which Payload
// converts with that field's own editor features.
const draftChangeFields = {
  collection: slugSchema,
  fields: z.record(fieldNameSchema, z.json()).optional(),
  markdown: z
    .record(fieldNameSchema, z.string().max(MAX_MARKDOWN_LENGTH))
    .optional(),
  // Opt-in: publish the document with this change instead of leaving it as
  // a draft. Payload's own access control still decides whether the editor
  // may publish.
  publish: z.literal(true).optional(),
};

// An update may publish a document without changing a field; a new
// document always needs fields.
const changeRules =
  (publishAlone: boolean) =>
  (operation: DraftChanges, ctx: z.RefinementCtx): void => {
    if (
      fieldKeys(operation).length === 0 &&
      !(publishAlone && operation.publish)
    ) {
      ctx.addIssue({
        code: "custom",
        message: publishAlone
          ? "operation must change at least one field or publish"
          : "operation must change at least one field",
      });
    }

    const fields = draftFields(operation);

    for (const key of Object.keys(draftMarkdown(operation))) {
      if (key in fields) {
        ctx.addIssue({
          code: "custom",
          message: `${key} is in both fields and markdown`,
          path: ["markdown", key],
        });
      }
    }
  };

const updateDraftOperationSchema = z
  .strictObject({
    ...draftChangeFields,
    // The document's `updatedAt` as the model read it. Set, the preview is
    // refused when the document has changed since.
    expected_updated_at: z.string().min(1).max(64).optional(),
    id: documentIdSchema,
    kind: z.literal("update_draft"),
  })
  .superRefine(changeRules(true));

const createDraftOperationSchema = z
  .strictObject({ ...draftChangeFields, kind: z.literal("create_draft") })
  .superRefine(changeRules(false));

// A file staged earlier in the same run with `payload.stageUpload`, named by
// the hash of its bytes. The bytes never travel in an operation.
const UPLOAD_REF = /^sha256:[0-9a-f]{64}$/u;
const uploadRefSchema = z.string().regex(UPLOAD_REF);

// A file name as Payload will be asked to store it: one path segment, no
// control characters, with an extension.
export const filenameSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*\.[A-Za-z0-9]{2,5}$/u);

const uploadFields = {
  collection: slugSchema,
  // The document's other fields, such as a media file's alt text. Payload
  // enforces the ones it requires.
  fields: z.record(fieldNameSchema, z.json()).optional(),
  // Stored under this name instead of the one the file was staged with.
  filename: filenameSchema.optional(),
  upload_ref: uploadRefSchema,
};

const uploadMediaOperationSchema = z.strictObject({
  ...uploadFields,
  kind: z.literal("upload_media"),
});

const replaceMediaFileOperationSchema = z.strictObject({
  ...uploadFields,
  // Required: a file replacement shows at once wherever the file is used, so
  // it is never made against a document the model did not just read.
  expected_updated_at: z.string().min(1).max(64),
  id: documentIdSchema,
  kind: z.literal("replace_media_file"),
});

// One change to one row of an array or blocks field. Paths are field names
// joined by dots, with `[id=<rowId>]` after a rows field to pick a row:
// `layout[id=6650a1f2].cards[id=b7c1].title`.
const rowPathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const rowIdSchema = z.string().regex(ROW_ID);

// A new row's own fields. Payload gives the row its id.
const newRowSchema = z
  .record(fieldNameSchema.or(z.literal("blockType")), z.json())
  .refine((row) => Object.keys(row).length > 0, {
    message: "a new row needs at least one field",
  });

const rowChangeSchema = z.discriminatedUnion("op", [
  // A field of one row, as Payload stores it.
  z.strictObject({
    op: z.literal("set"),
    path: rowPathSchema,
    value: z.json(),
  }),
  // A rich text field of one row, written as Markdown.
  z.strictObject({
    markdown: z.string().max(MAX_MARKDOWN_LENGTH),
    op: z.literal("set_markdown"),
    path: rowPathSchema,
  }),
  // A new row, first in the field or right after another row.
  z.strictObject({
    after_id: rowIdSchema.nullable(),
    field: rowPathSchema,
    op: z.literal("insert"),
    row: newRowSchema,
  }),
  z.strictObject({
    field: rowPathSchema,
    op: z.literal("remove"),
    row_id: rowIdSchema,
  }),
  z.strictObject({
    after_id: rowIdSchema.nullable(),
    field: rowPathSchema,
    op: z.literal("move"),
    row_id: rowIdSchema,
  }),
]);

export type RowChange = z.infer<typeof rowChangeSchema>;

export const MAX_ROW_CHANGES = 50;

// As many new rows as a receipt can name: it lists the id Payload gave each
// one, and a receipt detail is bounded.
export const MAX_ROW_INSERTS = 12;

// What a change names, for telling two changes to the same thing apart: a
// row's field, or a row that is removed or moved. Inserts never collide.
const changeKey = (change: RowChange): string | undefined => {
  if (change.op === "set" || change.op === "set_markdown") {
    parseRowFieldPath(change.path);

    return change.path;
  }

  parseRowsFieldPath(change.field);

  return change.op === "insert"
    ? undefined
    : `${change.field}[id=${change.row_id}]`;
};

// A row that is removed takes everything inside it along, so a change to
// one of its fields or to rows it holds would have nothing to be read back
// from. Such a pair is refused whichever way round it is sent.
const removedRowRules = (changes: RowChange[], ctx: z.RefinementCtx): void => {
  const removed = changes.flatMap((change) =>
    change.op === "remove" ? [`${change.field}[id=${change.row_id}].`] : []
  );

  for (const [index, change] of changes.entries()) {
    const where = "path" in change ? change.path : change.field;
    const inside = removed.find((row) => where.startsWith(row));

    if (inside !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${inside.slice(0, -1)} is removed, so nothing inside it can change`,
        path: ["changes", index],
      });
    }
  }
};

const rowChangeRules = (
  operation: { changes: RowChange[] },
  ctx: z.RefinementCtx
): void => {
  const seen = new Set<string>();

  for (const [index, change] of operation.changes.entries()) {
    try {
      const key = changeKey(change);

      if (key !== undefined && seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} is changed more than one time`,
          path: ["changes", index],
        });
      }

      if (key !== undefined) {
        seen.add(key);
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof ApplyValidationError
            ? error.message
            : "is not a row path",
        path: ["changes", index],
      });
    }

    if (change.op === "move" && change.after_id === change.row_id) {
      ctx.addIssue({
        code: "custom",
        message: "a row cannot be moved after itself",
        path: ["changes", index],
      });
    }
  }

  removedRowRules(operation.changes, ctx);

  const inserts = operation.changes.filter((change) => change.op === "insert");

  if (inserts.length > MAX_ROW_INSERTS) {
    ctx.addIssue({
      code: "custom",
      message: `an operation inserts at most ${MAX_ROW_INSERTS} rows`,
      path: ["changes"],
    });
  }
};

const patchRowsOperationSchema = z
  .strictObject({
    changes: z.array(rowChangeSchema).min(1).max(MAX_ROW_CHANGES),
    collection: slugSchema,
    // Required: the changes are made on the document as it was read, so
    // they are never made against one the model did not just read.
    expected_updated_at: z.string().min(1).max(64),
    id: documentIdSchema,
    kind: z.literal("patch_rows"),
    publish: z.literal(true).optional(),
  })
  .superRefine(rowChangeRules);

interface GlobalChanges {
  changes?: RowChange[] | undefined;
  fields?: Record<string, JsonValue> | undefined;
  publish?: true | undefined;
}

// The top-level fields a row path starts in, without taking the path apart.
const rowsFields = (changes: RowChange[]): string[] =>
  [
    ...new Set(
      changes.map(
        (change) =>
          /^[A-Za-z0-9_]+/u.exec(
            "path" in change ? change.path : change.field
          )?.[0] ?? ""
      )
    ),
  ].toSorted();

const globalRules = (operation: GlobalChanges, ctx: z.RefinementCtx): void => {
  const changes = operation.changes ?? [];
  const fields = Object.keys(draftFields(operation));

  rowChangeRules({ changes }, ctx);

  if (fields.length === 0 && changes.length === 0 && !operation.publish) {
    ctx.addIssue({
      code: "custom",
      message: "operation must change at least one field or row, or publish",
    });
  }

  for (const [index, change] of changes.entries()) {
    // Payload's Markdown tools convert for a collection's fields only.
    if (change.op === "set_markdown") {
      ctx.addIssue({
        code: "custom",
        message:
          "Markdown is not converted for a global; set the field as Payload stores it",
        path: ["changes", index],
      });
    }
  }

  for (const field of rowsFields(changes)) {
    if (fields.includes(field)) {
      ctx.addIssue({
        code: "custom",
        message: `${field} is in both fields and changes`,
        path: ["fields", field],
      });
    }
  }
};

// A global is one document of its own kind (site settings, a footer). Its
// top-level fields are set as Payload stores them, and rows of its array and
// blocks fields are changed as `patch_rows` changes them.
const updateGlobalOperationSchema = z
  .strictObject({
    changes: z.array(rowChangeSchema).min(1).max(MAX_ROW_CHANGES).optional(),
    // Required: a global without drafts is live the moment it is saved, so
    // it is never written against a state the model did not just read.
    expected_updated_at: z.string().min(1).max(64),
    fields: z.record(fieldNameSchema, z.json()).optional(),
    global: slugSchema,
    kind: z.literal("update_global"),
    // Publishes the change. A global without drafts takes no other kind of
    // change, so there the operation has to say it.
    publish: z.literal(true).optional(),
  })
  .superRefine(globalRules);

// Takes a published document off the public site. Its content stays, as a
// draft.
const unpublishOperationSchema = z.strictObject({
  collection: slugSchema,
  // Required: the public page goes away at once, so it is never taken down
  // on the strength of a state the model did not just read.
  expected_updated_at: z.string().min(1).max(64),
  id: documentIdSchema,
  kind: z.literal("unpublish"),
});

// As long as a version id may be: Payload's are numbers or short strings.
const versionIdSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/u),
]);

// Brings back an earlier version of a document, as a new draft unless the
// operation publishes.
const restoreVersionOperationSchema = z.strictObject({
  collection: slugSchema,
  // Required: a restore replaces every field, so it is never made over a
  // draft the model did not just read.
  expected_updated_at: z.string().min(1).max(64),
  id: documentIdSchema,
  kind: z.literal("restore_version"),
  publish: z.literal(true).optional(),
  version_id: versionIdSchema,
});

// The same for a global. One without drafts is live the moment it is
// restored, so there the operation has to say `publish: true`.
const restoreGlobalVersionOperationSchema = z.strictObject({
  expected_updated_at: z.string().min(1).max(64),
  global: slugSchema,
  kind: z.literal("restore_global_version"),
  publish: z.literal(true).optional(),
  version_id: versionIdSchema,
});

// Moves a document to the trash, where it can be restored. Nothing is
// deleted for good through the connector.
const trashOperationSchema = z.strictObject({
  collection: slugSchema,
  // Required: a published page goes away at once, so it is never trashed on
  // the strength of a state the model did not just read.
  expected_updated_at: z.string().min(1).max(64),
  id: documentIdSchema,
  kind: z.literal("trash"),
});

// Takes a document back out of the trash, as a draft unless the operation
// publishes.
const restoreFromTrashOperationSchema = z.strictObject({
  collection: slugSchema,
  expected_updated_at: z.string().min(1).max(64),
  id: documentIdSchema,
  kind: z.literal("restore_from_trash"),
  publish: z.literal(true).optional(),
});

const operationSchema = z.discriminatedUnion("kind", [
  updateDraftOperationSchema,
  createDraftOperationSchema,
  uploadMediaOperationSchema,
  replaceMediaFileOperationSchema,
  patchRowsOperationSchema,
  updateGlobalOperationSchema,
  unpublishOperationSchema,
  restoreVersionOperationSchema,
  restoreGlobalVersionOperationSchema,
  trashOperationSchema,
  restoreFromTrashOperationSchema,
]);

export type DraftOperation =
  | z.infer<typeof createDraftOperationSchema>
  | z.infer<typeof updateDraftOperationSchema>;

export type UpdateDraftOperation = z.infer<typeof updateDraftOperationSchema>;

export type UploadOperation =
  | z.infer<typeof replaceMediaFileOperationSchema>
  | z.infer<typeof uploadMediaOperationSchema>;

export type PatchRowsOperation = z.infer<typeof patchRowsOperationSchema>;

export type UpdateGlobalOperation = z.infer<typeof updateGlobalOperationSchema>;

export type UnpublishOperation = z.infer<typeof unpublishOperationSchema>;

export type RestoreOperation =
  | z.infer<typeof restoreGlobalVersionOperationSchema>
  | z.infer<typeof restoreVersionOperationSchema>;

export type TrashOperation =
  | z.infer<typeof restoreFromTrashOperationSchema>
  | z.infer<typeof trashOperationSchema>;

export type PayloadOperation = z.infer<typeof operationSchema>;

export const isRowsOperation = (
  operation: PayloadOperation
): operation is PatchRowsOperation => operation.kind === "patch_rows";

export const rowsTarget = (operation: PatchRowsOperation): string =>
  `${operation.collection}/${operation.id}`;

const rowChangesPhrase = (changes: RowChange[]): string =>
  `${changes.length} row ${changes.length === 1 ? "change" : "changes"} in ${joinPhrase(rowsFields(changes))}`;

export const rowsSentence = (operation: PatchRowsOperation): string => {
  const document = `${operation.collection} ${operation.id}`;
  const what = rowChangesPhrase(operation.changes);

  return operation.publish
    ? `Save ${what} to ${document} and publish it`
    : `Save ${what} as a draft of ${document}`;
};

export const isUnpublishOperation = (
  operation: PayloadOperation
): operation is UnpublishOperation => operation.kind === "unpublish";

export const unpublishTarget = (operation: UnpublishOperation): string =>
  `${operation.collection}/${operation.id}`;

export const unpublishSentence = (operation: UnpublishOperation): string =>
  `Unpublish ${operation.collection} ${operation.id}`;

export const isRestoreOperation = (
  operation: PayloadOperation
): operation is RestoreOperation =>
  operation.kind === "restore_version" ||
  operation.kind === "restore_global_version";

export const restoreTarget = (operation: RestoreOperation): string =>
  operation.kind === "restore_version"
    ? `${operation.collection}/${operation.id}`
    : `globals/${operation.global}`;

export const restoreSentence = (operation: RestoreOperation): string => {
  const what =
    operation.kind === "restore_version"
      ? `${operation.collection} ${operation.id}`
      : `the ${operation.global} global`;

  return operation.publish
    ? `Restore ${what} to version ${operation.version_id} and publish it`
    : `Restore ${what} to version ${operation.version_id} as a draft`;
};

export const isGlobalOperation = (
  operation: PayloadOperation
): operation is UpdateGlobalOperation => operation.kind === "update_global";

// A global has a slug and no id. No collection is called `globals` and holds
// a document by that slug in the same batch, in any site worth thinking of.
export const globalTarget = (operation: UpdateGlobalOperation): string =>
  `globals/${operation.global}`;

// The top-level fields the operation sets, in the order the approver sees.
export const globalFieldPaths = (operation: UpdateGlobalOperation): string[] =>
  Object.keys(draftFields(operation)).toSorted();

export const globalSentence = (operation: UpdateGlobalOperation): string => {
  const changes = operation.changes ?? [];
  const global = `the ${operation.global} global`;

  const what = joinPhrase([
    ...globalFieldPaths(operation),
    ...(changes.length > 0 ? [rowChangesPhrase(changes)] : []),
  ]);

  if (!operation.publish) {
    return `Save ${what} as a draft of ${global}`;
  }

  return what === ""
    ? `Publish ${global}`
    : `Save ${what} to ${global} and publish it`;
};

export const isUploadOperation = (
  operation: PayloadOperation
): operation is UploadOperation =>
  operation.kind === "upload_media" || operation.kind === "replace_media_file";

// The SHA-256 an `upload_ref` names.
export const uploadSha256 = (operation: UploadOperation): string =>
  operation.upload_ref.slice("sha256:".length);

// A new file has no id until Payload saves it.
export const uploadTarget = (operation: UploadOperation): string =>
  operation.kind === "upload_media"
    ? `${operation.collection}/new`
    : `${operation.collection}/${operation.id}`;

// The name is added where the staged file is known; this is the sentence
// from the operation alone.
export const uploadSentence = (operation: UploadOperation): string => {
  const named = operation.filename ? ` as ${operation.filename}` : "";

  return operation.kind === "upload_media"
    ? `Upload a file to ${operation.collection}${named}`
    : `Replace the file of ${operation.collection} ${operation.id}${named}`;
};

// A new document has no id until Payload saves it, so its target names the
// collection alone.
export const draftTarget = (operation: DraftOperation): string =>
  operation.kind === "create_draft"
    ? `${operation.collection}/new`
    : `${operation.collection}/${operation.id}`;

// The fields the approver sees, `_status` last when the operation publishes.
export const draftChangedPaths = (operation: DraftOperation): string[] =>
  operation.publish
    ? [...fieldKeys(operation), STATUS_FIELD]
    : fieldKeys(operation);

const updateSentence = (operation: UpdateDraftOperation): string => {
  const document = `${operation.collection} ${operation.id}`;
  const fields = fieldKeys(operation);

  if (!operation.publish) {
    return `Save ${joinPhrase(fields)} as a draft of ${document}`;
  }

  return fields.length === 0
    ? `Publish ${document}`
    : `Save ${joinPhrase(fields)} to ${document} and publish it`;
};

export const draftSentence = (operation: DraftOperation): string => {
  if (operation.kind === "update_draft") {
    return updateSentence(operation);
  }

  const fields = joinPhrase(fieldKeys(operation));

  return operation.publish
    ? `Create and publish a new ${operation.collection} with ${fields}`
    : `Create a new ${operation.collection} draft with ${fields}`;
};

export const isTrashOperation = (
  operation: PayloadOperation
): operation is TrashOperation =>
  operation.kind === "trash" || operation.kind === "restore_from_trash";

export const trashTarget = (operation: TrashOperation): string =>
  `${operation.collection}/${operation.id}`;

export const trashSentence = (operation: TrashOperation): string => {
  const document = `${operation.collection} ${operation.id}`;

  if (operation.kind === "trash") {
    return `Move ${document} to the trash`;
  }

  return operation.publish
    ? `Restore ${document} from the trash and publish it`
    : `Restore ${document} from the trash as a draft`;
};

export const operationTarget = (operation: PayloadOperation): string => {
  if (isUploadOperation(operation)) {
    return uploadTarget(operation);
  }

  if (isGlobalOperation(operation)) {
    return globalTarget(operation);
  }

  if (isUnpublishOperation(operation)) {
    return unpublishTarget(operation);
  }

  if (isRestoreOperation(operation)) {
    return restoreTarget(operation);
  }

  if (isTrashOperation(operation)) {
    return trashTarget(operation);
  }

  return isRowsOperation(operation)
    ? rowsTarget(operation)
    : draftTarget(operation);
};

export const operationSentence = (operation: PayloadOperation): string => {
  if (isUploadOperation(operation)) {
    return uploadSentence(operation);
  }

  if (isGlobalOperation(operation)) {
    return globalSentence(operation);
  }

  if (isUnpublishOperation(operation)) {
    return unpublishSentence(operation);
  }

  if (isRestoreOperation(operation)) {
    return restoreSentence(operation);
  }

  if (isTrashOperation(operation)) {
    return trashSentence(operation);
  }

  return isRowsOperation(operation)
    ? rowsSentence(operation)
    : draftSentence(operation);
};

// An operation on a document that exists already. Each makes its own
// document otherwise, so those never collide.
const namesExistingTarget = (operation: PayloadOperation): boolean =>
  operation.kind === "update_draft" ||
  operation.kind === "replace_media_file" ||
  operation.kind === "patch_rows" ||
  operation.kind === "update_global" ||
  operation.kind === "unpublish" ||
  operation.kind === "restore_version" ||
  operation.kind === "restore_global_version" ||
  operation.kind === "trash" ||
  operation.kind === "restore_from_trash";

const draftApplyInputSchema = z
  .object({
    intent: z.string().trim().min(1).max(500),
    operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS),
  })
  // One update per document, for the same reason as `wp.apply`: the first
  // write moves `updatedAt`, so a second one would always report a conflict.
  // Each create makes its own document, so creates never collide.
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    for (const [index, operation] of input.operations.entries()) {
      if (!namesExistingTarget(operation)) {
        continue;
      }

      const target = operationTarget(operation);

      if (seen.has(target)) {
        ctx.addIssue({
          code: "custom",
          message: `batch addresses ${target} more than once`,
          params: { code: "duplicate_target" },
          path: ["operations", index],
        });
      }

      seen.add(target);
    }
  });

export interface DraftApplyInput {
  intent: string;
  operations: PayloadOperation[];
}

// The `payload.apply` I/O boundary, as `parseApplyInput` is for `wp.apply`.
export const parseDraftApplyInput = <T>(input: T): DraftApplyInput => {
  const parsed = draftApplyInputSchema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  const duplicate = parsed.error.issues.some((issue) =>
    issue.message.includes("more than once")
  );

  throw new ApplyValidationError(
    duplicate ? "duplicate_target" : "invalid_operations",
    detail
  );
};
