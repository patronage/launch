import {
  ApplyValidationError,
  MAX_OPERATIONS,
  joinPhrase,
} from "@patronage/mcp-core";
import { z } from "zod";

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

// Registered REST meta (`register_post_meta` with `show_in_rest`). WordPress
// decides which keys are writable and runs each key's `auth_callback`; a key
// the site never registered is dropped by WordPress and reported by readback.
const META_KEY_LIMIT = 255;

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
    meta: z.record(z.string().min(1).max(META_KEY_LIMIT), z.json()).optional(),
    rest_base: restBaseSchema,
  })
  .refine(
    (operation) =>
      changedFieldKeys(operation.fields).length > 0 ||
      Object.keys(operation.acf ?? {}).length > 0 ||
      Object.keys(operation.meta ?? {}).length > 0,
    { message: "operation must change at least one field, acf key or meta key" }
  );

export type UpdatePostOperation = z.infer<typeof updatePostOperationSchema>;

// A path on this site, as Redirection stores a plain-URL rule's source: one
// leading slash, no scheme, host or fragment. Query strings are kept, because
// Redirection matches them.
const redirectSourceSchema = z
  .string()
  .trim()
  .min(2)
  .max(2000)
  .regex(/^\/(?!\/)[^\s#]*$/u, "source must be a site path such as /old-page");

// Either a site path or an absolute http(s) URL.
const redirectTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      /^\/(?!\/)\S*$/u.test(value) || /^https?:\/\/[^\s/]+\S*$/iu.test(value),
    { message: "target must be a site path or an http(s) URL" }
  );

export const REDIRECT_CODES = [301, 302, 307, 308] as const;

const upsertRedirectOperationSchema = z
  .strictObject({
    code: z.literal(REDIRECT_CODES).default(301),
    kind: z.literal("upsert_redirect"),
    source: redirectSourceSchema,
    target: redirectTargetSchema,
  })
  .refine((operation) => operation.source !== operation.target, {
    message: "a redirect cannot point at its own source",
  });

export type UpsertRedirectOperation = z.infer<
  typeof upsertRedirectOperationSchema
>;

const writeOperationSchema = z.discriminatedUnion("kind", [
  updatePostOperationSchema,
  upsertRedirectOperationSchema,
]);

export type WriteOperation = UpdatePostOperation | UpsertRedirectOperation;

export const isRedirectOperation = (
  operation: WriteOperation
): operation is UpsertRedirectOperation => operation.kind === "upsert_redirect";

export const operationTarget = (operation: WriteOperation): string =>
  isRedirectOperation(operation)
    ? `redirect ${operation.source}`
    : `${operation.rest_base}/${operation.id}`;

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
    operations: z.array(writeOperationSchema).min(1).max(MAX_OPERATIONS),
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

export const REDIRECT_PATHS = ["target", "code"] as const;

export const changedPaths = (operation: WriteOperation): string[] => {
  if (isRedirectOperation(operation)) {
    return [...REDIRECT_PATHS];
  }

  const paths = changedFieldKeys(operation.fields);

  for (const key of Object.keys(operation.acf ?? {}).toSorted()) {
    paths.push(`acf.${key}`);
  }

  for (const key of Object.keys(operation.meta ?? {}).toSorted()) {
    paths.push(`meta.${key}`);
  }

  return paths;
};

export const operationSentence = (operation: WriteOperation): string => {
  if (isRedirectOperation(operation)) {
    return `Redirect ${operation.source} to ${operation.target} (${operation.code})`;
  }

  const paths = joinPhrase(changedPaths(operation));

  return `Update ${paths} on ${operation.rest_base} ${operation.id}`;
};
