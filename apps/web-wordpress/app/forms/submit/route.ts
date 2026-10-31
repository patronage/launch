import { z } from "zod";

import { wordpressEnv } from "@/lib/wordpress/env";
import { wordpressFetch } from "@/lib/wordpress/fetch";

export const dynamic = "force-dynamic";

/** Largest request body read, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** The body @launch/ui's Form posts: field names mapped to their values. */
const Submission = z.object({
  formId: z.string().regex(/^\d+$/u),
  values: z.record(z.string(), z.string()),
});

/** What WordPress answers: `{ ok }`, or a WP_Error's `{ message }`. */
const WordPressAnswer = z.object({ message: z.string().optional() });

const reject = (message: string, status = 400) =>
  Response.json({ message }, { status });

/** The request body as text, or undefined when it is larger than allowed. */
const readBody = async (request: Request): Promise<string | undefined> => {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return undefined;
  }

  const text = await request.text();

  return new TextEncoder().encode(text).length > MAX_BODY_BYTES
    ? undefined
    : text;
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
 * Passes a form section's submission to the theme's Formidable route
 * (apps/cms-wordpress-headless, inc/forms.php), which checks each value
 * against its field and saves the entry. The shared secret keeps that route
 * to this app; WordPress's answer and status come back as they are.
 */
export const POST = async (request: Request): Promise<Response> => {
  const body = await readBody(request);

  if (body === undefined) {
    return reject("Submission too large.", 413);
  }

  const parsed = parseSubmission(body);

  if (!parsed.success) {
    return reject("Expected { formId, values }.");
  }

  const { origin, secret } = wordpressEnv();

  if (!secret) {
    return reject("Forms are not configured.", 503);
  }

  const response = await wordpressFetch(
    `${origin}/wp-json/patronage/v1/forms/${parsed.data.formId}/submissions`,
    {
      body: JSON.stringify({ values: parsed.data.values }),
      headers: {
        "content-type": "application/json",
        "x-headless-secret-key": secret,
      },
      method: "POST",
    }
  );

  if (response.ok) {
    await response.body?.cancel();

    return Response.json({ ok: true }, { status: 201 });
  }

  const answer = WordPressAnswer.safeParse(
    await response.json().catch(() => null)
  );

  // A refused secret or a server error is WordPress's to log; the visitor
  // gets a plain message.
  return response.status >= 500 || [401, 403].includes(response.status)
    ? reject("The form could not be sent.", 502)
    : reject(
        (answer.success && answer.data.message) || "Submission rejected.",
        response.status
      );
};
