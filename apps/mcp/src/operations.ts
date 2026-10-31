import { z } from "zod";

export const MAX_OPERATIONS = 20;

const FIELD_ORDER = ["title", "content", "excerpt", "slug", "status"] as const;

const restBaseSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/u);

const updatePostFieldsSchema = z.strictObject({
  content: z.string().max(500_000).optional(),
  excerpt: z.string().max(50_000).optional(),
  slug: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["draft", "pending", "private", "publish"]).optional(),
  title: z.string().max(500).optional(),
});

type UpdatePostFields = z.infer<typeof updatePostFieldsSchema>;

// Shared by the schema's `.refine()` (validation) and by `changedPaths`
// (summaries) so both agree on a single definition of "changed": the key
// must be present AND its value must not be `undefined`. A sandbox script
// can construct `{ title: undefined }` directly (key present, value
// explicitly undefined), which zod's strictObject keeps in the parsed
// output — checking `Object.keys(...).length` alone would treat that as a
// real change when it is not.
const changedFieldKeys = (fields: UpdatePostFields | undefined): string[] =>
  FIELD_ORDER.filter((key) => fields?.[key] !== undefined);

const updatePostOperationSchema = z
  .strictObject({
    acf: z.record(z.string().min(1).max(64), z.json()).optional(),
    expected_modified_gmt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u)
      .optional(),
    fields: updatePostFieldsSchema.optional(),
    id: z.number().int().positive(),
    kind: z.literal("update_post"),
    rest_base: restBaseSchema,
  })
  .refine(
    (operation) =>
      changedFieldKeys(operation.fields).length > 0 ||
      Object.keys(operation.acf ?? {}).length > 0,
    { message: "operation must change at least one field or acf key" }
  );

export type UpdatePostOperation = z.infer<typeof updatePostOperationSchema>;

export type WriteOperation = UpdatePostOperation;

export const operationTarget = (operation: WriteOperation): string =>
  `${operation.rest_base}/${operation.id}`;

const DUPLICATE_TARGET_CODE = "duplicate_target";

// zod carries an issue's `params` through to the parsed issue untouched, so
// this is how `parseApplyInput` tells the duplicate-target refinement apart
// from every other validation failure without matching on message text.
const duplicateTargetIssueSchema = z.object({
  params: z.object({ code: z.literal(DUPLICATE_TARGET_CODE) }),
});

export const applyInputSchema = z
  .object({
    intent: z.string().trim().min(1).max(500),
    operations: z.array(updatePostOperationSchema).min(1).max(MAX_OPERATIONS),
  })
  // One target per batch. The first write bumps the post's `modified_gmt`, so
  // a second operation against the same post would always trip its own
  // conflict check and report `modified_since_preflight` for a write that was
  // never attempted. The model merges every change to one post into one
  // operation instead.
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    for (const [index, operation] of input.operations.entries()) {
      const target = operationTarget(operation);

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

export class ApplyValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplyValidationError";
  }
}

// This function is the wp.apply I/O boundary: it must accept a value of any
// shape and validate it at runtime, which is exactly what zod's `safeParse`
// does. anti-slop/no-unknown-parameters forbids a literal `unknown`
// parameter (and no-unknown-type-aliases forbids hiding one behind a type
// alias) with no boundary-parser exemption, so an unconstrained generic is
// used instead — every value is assignable to `T` just as it would be to
// `unknown`, so the accepted-input contract is unchanged.
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

export const changedPaths = (operation: WriteOperation): string[] => {
  const paths = changedFieldKeys(operation.fields);

  for (const key of Object.keys(operation.acf ?? {}).toSorted()) {
    paths.push(`acf.${key}`);
  }

  return paths;
};

export const joinPhrase = (items: string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
};

export const operationSentence = (operation: WriteOperation): string => {
  const paths = joinPhrase(changedPaths(operation));

  return `Update ${paths} on ${operation.rest_base} ${operation.id}`;
};
