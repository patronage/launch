import type { NextRequest } from "next/server";
import { z } from "zod";

import { getFrontendPayload } from "@/lib/payload";

/** Longest value kept from any one field. */
const MAX_VALUE_LENGTH = 5000;

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

/**
 * Turns a form section's submission into a form-builder submission. Only the
 * form's own fields are kept, required ones must be filled, and the create
 * runs with the visitor's access, like every front-end Local API call.
 */
export const POST = async (req: NextRequest): Promise<Response> => {
  const parsed = Submission.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return reject("Expected { formId, values }.");
  }

  const { formId } = parsed.data;
  // A Map, so a field named like an Object.prototype key reads nothing.
  const values = new Map(Object.entries(parsed.data.values));

  const { payload, user } = await getFrontendPayload();

  const form = await payload
    .findByID({
      collection: "forms",
      depth: 0,
      id: formId,
      overrideAccess: false,
      user,
    })
    .catch(() => null);

  if (!form) {
    return reject("No such form.", 404);
  }

  const submissionData = [];

  for (const field of form.fields ?? []) {
    const name = "name" in field ? field.name : undefined;
    const value = name ? values.get(name)?.trim() : undefined;
    const required = "required" in field && field.required === true;

    // A checkbox posts "false" when unticked; a required one must be ticked.
    const missing =
      !value || (field.blockType === "checkbox" && value === "false");

    if (name && required && missing) {
      return reject(`${name} is required.`);
    }

    // Submission values are required, so empty optional fields are left out.
    if (name && value) {
      submissionData.push({ field: name, value });
    }
  }

  await payload.create({
    collection: "form-submissions",
    data: { form: form.id, submissionData },
    overrideAccess: false,
    user,
  });

  return Response.json({ ok: true }, { status: 201 });
};
