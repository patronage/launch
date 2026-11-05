import type { NextRequest } from "next/server";
import { z } from "zod";

import { getFrontendPayload } from "@/lib/payload";
import type { Form } from "@/payload-types";

/** Longest value kept from any one field. */
const MAX_VALUE_LENGTH = 5000;

/** Largest request body read, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** The body @launch/ui's Form posts: field names mapped to their values. */
const Submission = z.object({
  formId: z.string(),
  values: z.record(
    z.string(),
    z.string().transform((value) => value.slice(0, MAX_VALUE_LENGTH))
  ),
});

const reject = (message: string, status = 400) =>
  Response.json({ message }, { status });

type FormFieldBlock = NonNullable<Form["fields"]>[number];

/** Why a filled-in value does not fit its field, or undefined when it does. */
const invalid = (field: FormFieldBlock, value: string): string | undefined => {
  switch (field.blockType) {
    case "checkbox": {
      return value === "true" || value === "false"
        ? undefined
        : "must be true or false";
    }

    case "email": {
      return EMAIL.test(value) ? undefined : "must be an email address";
    }

    case "number": {
      return Number.isFinite(Number(value)) ? undefined : "must be a number";
    }

    case "select": {
      return field.options?.some((option) => option.value === value)
        ? undefined
        : "must be one of its options";
    }

    default: {
      return undefined;
    }
  }
};

/**
 * The request body as text, or undefined when it is larger than allowed. The
 * stream is counted as it arrives and cancelled past the limit, so a body
 * sent without Content-Length is never buffered whole first.
 */
const readBody = async (req: NextRequest): Promise<string | undefined> => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return undefined;
  }

  if (!req.body) {
    return "";
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read in order.
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > MAX_BODY_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- stops the stream once, then returns.
      await reader.cancel();

      return undefined;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
};

/** Parses the body as a submission; malformed JSON fails like a bad shape. */
const parseSubmission = (body: string) => {
  try {
    return Submission.safeParse(JSON.parse(body));
  } catch {
    return Submission.safeParse(null);
  }
};

/**
 * The submission's values for the form's own fields, or the first problem
 * found. Empty optional fields are left out, since submission values are
 * required.
 */
const submissionData = (
  fields: FormFieldBlock[],
  values: Map<string, string>
): { data: { field: string; value: string }[] } | { problem: string } => {
  const data = [];

  for (const field of fields) {
    const name = "name" in field ? field.name : undefined;
    const value = name ? values.get(name)?.trim() : undefined;
    const required = "required" in field && field.required === true;

    // A checkbox posts "false" when unticked; a required one must be ticked.
    const missing =
      !value || (field.blockType === "checkbox" && value === "false");

    if (name && required && missing) {
      return { problem: `${name} is required.` };
    }

    if (name && value) {
      const problem = invalid(field, value);

      if (problem) {
        return { problem: `${name} ${problem}.` };
      }

      data.push({ field: name, value });
    }
  }

  return { data };
};

/**
 * Turns a form section's submission into a form-builder submission. Only the
 * form's own fields are kept, values must fit their fields, and the create
 * runs with the visitor's access, like every front-end Local API call.
 */
export const POST = async (req: NextRequest): Promise<Response> => {
  const body = await readBody(req);

  if (body === undefined) {
    return reject("Submission too large.", 413);
  }

  const parsed = parseSubmission(body);

  if (!parsed.success) {
    return reject("Expected { formId, values }.");
  }

  const { payload, user } = await getFrontendPayload();

  const form = await payload
    .findByID({
      collection: "forms",
      depth: 0,
      id: parsed.data.formId,
      overrideAccess: false,
      user,
    })
    .catch(() => null);

  if (!form) {
    return reject("No such form.", 404);
  }

  // A Map, so a field named like an Object.prototype key reads nothing.
  const result = submissionData(
    form.fields ?? [],
    new Map(Object.entries(parsed.data.values))
  );

  if ("problem" in result) {
    return reject(result.problem);
  }

  await payload.create({
    collection: "form-submissions",
    data: { form: form.id, submissionData: result.data },
    overrideAccess: false,
    user,
  });

  return Response.json({ ok: true }, { status: 201 });
};
