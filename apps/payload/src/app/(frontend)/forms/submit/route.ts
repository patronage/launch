import type { NextRequest } from "next/server";

import {
  parseSubmission,
  readBody,
  submissionData,
} from "@/lib/form-submission";
import { getFrontendPayload } from "@/lib/payload";

const reject = (message: string, status = 400) =>
  Response.json({ message }, { status });

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
