import {
  ApplyValidationError,
  MAX_OPERATIONS,
  joinPhrase,
} from "@patronage/mcp-core";
import type { JsonValue } from "@patronage/mcp-core";
import { z } from "zod";

// What `payload.apply` can change: top-level fields of one document, saved as
// a new draft of it or as a new draft document. A change is published only
// when its operation says `publish: true`, which the approval preview shows
// as its own `_status` row. The fields Payload manages itself are refused in
// `fields`: the id, the timestamps, and every `_`-prefixed key, so `_status`
// changes only through `publish`.
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
