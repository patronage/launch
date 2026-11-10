import { z } from "zod";

import type { Form } from "@/payload-types";

// The checks behind the form section's submit route, kept apart from the
// route so they can be tested without Next or Payload.

/** Longest value kept from any one field. */
export const MAX_VALUE_LENGTH = 5000;

/** Largest request body read, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** The body @launch/ui's Form posts: field names mapped to their values. */
const Submission = z.object({
  formId: z.string(),
  values: z.record(
    z.string(),
    z.string().transform((value) => value.slice(0, MAX_VALUE_LENGTH))
  ),
});

export type FormFieldBlock = NonNullable<Form["fields"]>[number];

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
export const readBody = async (req: Request): Promise<string | undefined> => {
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
export const parseSubmission = (body: string) => {
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
export const submissionData = (
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
