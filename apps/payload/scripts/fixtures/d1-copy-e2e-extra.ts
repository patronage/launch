// Adds what the seed lacks to the throwaway D1 of the D1-to-Postgres e2e test
// (scripts/d1-to-postgres-e2e.test.mjs): a user with a password and a form
// submission. With `check <file>` as its arguments it instead signs that user
// in and creates a category, on whichever database PAYLOAD_DB picks, and
// writes the result to <file> as JSON.
import { writeFileSync } from "node:fs";

import config from "@payload-config";
import { getPayload } from "payload";

const EMAIL = "editor@example.com";
const PASSWORD = "e2e-password-not-secret";

const payload = await getPayload({ config });

if (process.argv.at(-2) === "check") {
  const login = await payload.login({
    collection: "users",
    data: { email: EMAIL, password: PASSWORD },
  });

  const category = await payload.create({
    collection: "categories",
    data: { slug: "after-copy", title: "After copy" },
    overrideAccess: true,
  });

  writeFileSync(
    process.argv.at(-1) ?? "",
    JSON.stringify({ categoryId: category.id, signedIn: Boolean(login.token) })
  );
} else {
  await payload.create({
    collection: "users",
    data: { email: EMAIL, password: PASSWORD },
    overrideAccess: true,
    // The first user may only be created on this machine (first-user-guard).
    // SAFETY: Payload fills in the rest of the request; the guard reads only headers.
    req: { headers: new Headers({ host: "localhost" }) } as never,
  });

  const {
    docs: [form],
  } = await payload.find({ collection: "forms", limit: 1 });

  await payload.create({
    collection: "form-submissions",
    data: {
      form: form.id,
      submissionData: [{ field: "email", value: "visitor@example.com" }],
    },
    overrideAccess: true,
  });
}

await payload.destroy();
