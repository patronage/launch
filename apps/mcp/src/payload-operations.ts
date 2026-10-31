import { z } from "zod";

import { ApplyValidationError, joinPhrase, MAX_OPERATIONS } from "./operations";
import type { JsonValue } from "./wordpress";

// What `payload.apply` can change: top-level fields of one document, saved as
// a new draft. Publishing stays with a person in the Payload admin, so the
// fields Payload manages itself are refused: the id, the timestamps, and every
// `_`-prefixed key, `_status` above all.
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

const changedFieldKeys = (fields: Record<string, JsonValue>): string[] =>
  Object.keys(fields)
    .filter((key) => fields[key] !== undefined)
    .toSorted();

const updateDraftOperationSchema = z
  .strictObject({
    collection: slugSchema,
    // The document's `updatedAt` as the model read it. Set, the preview is
    // refused when the document has changed since.
    expected_updated_at: z.string().min(1).max(64).optional(),
    fields: z.record(fieldNameSchema, z.json()),
    id: documentIdSchema,
    kind: z.literal("update_draft"),
  })
  .refine((operation) => changedFieldKeys(operation.fields).length > 0, {
    message: "operation must change at least one field",
  });

export type DraftOperation = z.infer<typeof updateDraftOperationSchema>;

export const draftTarget = (operation: DraftOperation): string =>
  `${operation.collection}/${operation.id}`;

export const draftChangedPaths = (operation: DraftOperation): string[] =>
  changedFieldKeys(operation.fields);

export const draftSentence = (operation: DraftOperation): string =>
  `Save ${joinPhrase(draftChangedPaths(operation))} as a draft of ${operation.collection} ${operation.id}`;

const draftApplyInputSchema = z
  .object({
    intent: z.string().trim().min(1).max(500),
    operations: z.array(updateDraftOperationSchema).min(1).max(MAX_OPERATIONS),
  })
  // One operation per document, for the same reason as `wp.apply`: the first
  // write moves `updatedAt`, so a second one would always report a conflict.
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    for (const [index, operation] of input.operations.entries()) {
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
