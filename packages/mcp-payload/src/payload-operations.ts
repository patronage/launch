import {
  ApplyValidationError,
  MAX_OPERATIONS,
  joinPhrase,
} from "@patronage/mcp-core";
import type { JsonValue } from "@patronage/mcp-core";
import { z } from "zod";

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

const operationSchema = z.discriminatedUnion("kind", [
  updateDraftOperationSchema,
  createDraftOperationSchema,
  uploadMediaOperationSchema,
  replaceMediaFileOperationSchema,
]);

export type DraftOperation =
  | z.infer<typeof createDraftOperationSchema>
  | z.infer<typeof updateDraftOperationSchema>;

export type UpdateDraftOperation = z.infer<typeof updateDraftOperationSchema>;

export type UploadOperation =
  | z.infer<typeof replaceMediaFileOperationSchema>
  | z.infer<typeof uploadMediaOperationSchema>;

export type PayloadOperation = z.infer<typeof operationSchema>;

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

export const operationTarget = (operation: PayloadOperation): string =>
  isUploadOperation(operation)
    ? uploadTarget(operation)
    : draftTarget(operation);

export const operationSentence = (operation: PayloadOperation): string =>
  isUploadOperation(operation)
    ? uploadSentence(operation)
    : draftSentence(operation);

// An operation on a document that exists already. Each makes its own
// document otherwise, so those never collide.
const namesExistingTarget = (operation: PayloadOperation): boolean =>
  operation.kind === "update_draft" || operation.kind === "replace_media_file";

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
