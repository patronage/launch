import {
  ApplyValidationError,
  MAX_OPERATIONS,
  joinPhrase,
} from "@patronage/mcp-core";
import { z } from "zod";

// A collection slug or an entry id, as the read allowlist matches them.
const segmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

// A field slug. EmDash keeps its own bookkeeping in a draft under keys that
// start with `_` (the staged slug is `_slug`), so those are never writable.
const fieldKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "field names are lowercase slugs");

const fieldsSchema = z
  .record(fieldKeySchema, z.json())
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "fields must name at least one field",
  });

// EmDash's opaque revision token, read from `_rev` beside the entry.
const revSchema = z.string().trim().min(1).max(200);

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "slug must be lowercase-with-dashes");

const updateDraftSchema = z.strictObject({
  collection: segmentSchema,
  expected_rev: revSchema.optional(),
  fields: fieldsSchema,
  id: segmentSchema,
  kind: z.literal("update_draft"),
});

const createDraftSchema = z.strictObject({
  collection: segmentSchema,
  fields: fieldsSchema,
  kind: z.literal("create_draft"),
  slug: slugSchema.optional(),
});

const publishSchema = z.strictObject({
  collection: segmentSchema,
  expected_rev: revSchema.optional(),
  id: segmentSchema,
  kind: z.literal("publish"),
});

export type UpdateDraftOperation = z.infer<typeof updateDraftSchema>;

export type CreateDraftOperation = z.infer<typeof createDraftSchema>;

export type PublishOperation = z.infer<typeof publishSchema>;

export type EmDashOperation =
  | CreateDraftOperation
  | PublishOperation
  | UpdateDraftOperation;

const operationSchema = z.discriminatedUnion("kind", [
  updateDraftSchema,
  createDraftSchema,
  publishSchema,
]);

export const operationTarget = (
  operation: EmDashOperation,
  index: number
): string =>
  operation.kind === "create_draft"
    ? `${operation.collection} (new #${index + 1})`
    : `${operation.collection}/${operation.id}`;

const DUPLICATE_TARGET_CODE = "duplicate_target";

const duplicateTargetIssueSchema = z.object({
  params: z.object({ code: z.literal(DUPLICATE_TARGET_CODE) }),
});

export const applyInputSchema = z
  .object({
    intent: z.string().trim().min(1).max(500),
    operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS),
  })
  // One operation per entry. A saved draft advances the entry's `_rev`, so a
  // second operation on it would always fail its own revision check: a save
  // and its publish are two calls, the publish naming the save's new rev.
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    for (const [index, operation] of input.operations.entries()) {
      const target = operationTarget(operation, index);

      if (seen.has(target)) {
        ctx.addIssue({
          code: "custom",
          message: `batch addresses ${target} more than once`,
          params: { code: DUPLICATE_TARGET_CODE },
          path: ["operations", index],
        });
      }

      seen.add(target);
    }
  });

export type ApplyInput = z.infer<typeof applyInputSchema>;

// The emdash.apply I/O boundary: any value, validated at runtime. A generic
// stands in for `unknown`, as in the WordPress connector.
export const parseApplyInput = <T>(input: T): ApplyInput => {
  const parsed = applyInputSchema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  const duplicate = parsed.error.issues.some(
    (issue) => duplicateTargetIssueSchema.safeParse(issue).success
  );

  throw new ApplyValidationError(
    duplicate ? DUPLICATE_TARGET_CODE : "invalid_operations",
    detail
  );
};

export const writtenPaths = (
  operation: CreateDraftOperation | UpdateDraftOperation
): string[] => Object.keys(operation.fields).toSorted();

export const operationSentence = (
  operation: EmDashOperation,
  index: number
): string => {
  if (operation.kind === "publish") {
    return `Publish ${operation.collection} ${operation.id}`;
  }

  const fields = joinPhrase(writtenPaths(operation));

  return operation.kind === "create_draft"
    ? `Create a ${operation.collection} draft with ${fields} (${operationTarget(operation, index)})`
    : `Save ${fields} on ${operation.collection} ${operation.id} as a draft`;
};
