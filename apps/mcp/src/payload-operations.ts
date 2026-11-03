import { z } from "zod";

import { ApplyValidationError, joinPhrase, MAX_OPERATIONS } from "./operations";
import type { JsonValue } from "./wordpress";

// What `payload.apply` can change: top-level fields of one document, saved as
// a new draft of it or as a new draft document. Publishing stays with a person
// in the Payload admin, so the fields Payload manages itself are refused: the
// id, the timestamps, and every `_`-prefixed key, `_status` above all.
const RESERVED_FIELDS = new Set(["createdAt", "deletedAt", "id", "updatedAt"]);

const slugSchema = z
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
}

export const draftFields = (
  operation: DraftChanges
): Record<string, JsonValue> => operation.fields ?? {};

export const draftMarkdown = (
  operation: DraftChanges
): Record<string, string> => operation.markdown ?? {};

const changedFieldKeys = (operation: DraftChanges): string[] => {
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
};

const changeRules = (operation: DraftChanges, ctx: z.RefinementCtx): void => {
  if (changedFieldKeys(operation).length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "operation must change at least one field",
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
  .superRefine(changeRules);

const createDraftOperationSchema = z
  .strictObject({ ...draftChangeFields, kind: z.literal("create_draft") })
  .superRefine(changeRules);

const draftOperationSchema = z.discriminatedUnion("kind", [
  updateDraftOperationSchema,
  createDraftOperationSchema,
]);

export type DraftOperation = z.infer<typeof draftOperationSchema>;

export type UpdateDraftOperation = z.infer<typeof updateDraftOperationSchema>;

// A new document has no id until Payload saves it, so its target names the
// collection alone.
export const draftTarget = (operation: DraftOperation): string =>
  operation.kind === "create_draft"
    ? `${operation.collection}/new`
    : `${operation.collection}/${operation.id}`;

export const draftChangedPaths = (operation: DraftOperation): string[] =>
  changedFieldKeys(operation);

export const draftSentence = (operation: DraftOperation): string =>
  operation.kind === "create_draft"
    ? `Create a new ${operation.collection} draft with ${joinPhrase(draftChangedPaths(operation))}`
    : `Save ${joinPhrase(draftChangedPaths(operation))} as a draft of ${operation.collection} ${operation.id}`;

const draftApplyInputSchema = z
  .object({
    intent: z.string().trim().min(1).max(500),
    operations: z.array(draftOperationSchema).min(1).max(MAX_OPERATIONS),
  })
  // One update per document, for the same reason as `wp.apply`: the first
  // write moves `updatedAt`, so a second one would always report a conflict.
  // Each create makes its own document, so creates never collide.
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    for (const [index, operation] of input.operations.entries()) {
      if (operation.kind === "create_draft") {
        continue;
      }

      const target = draftTarget(operation);

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
  operations: DraftOperation[];
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
