/**
 * Finishes local setup once `pnpm --filter @launch/emdash dev` answers:
 *
 * 1. Signs in through EmDash's development-only setup bypass, which applies
 *    seed/seed.json to the empty database (the dev server's own D1 and R2).
 * 2. Creates the demo form the Apply page places, through the forms plugin's
 *    admin API, unless it exists. The seed can't hold plugin data.
 *
 * The bypass answers 403 outside `astro dev`, so this cannot touch a deployed
 * site. Run it again any time.
 */
import { demoForm } from "../seed/form.ts";

const siteUrl = process.env.EMDASH_URL ?? "http://localhost:4321";
const api = `${siteUrl}/_emdash/api`;

/** EmDash's CSRF check wants this header on every write. */
const headers = { "X-EmDash-Request": "1" };

const fail = (message: string): never => {
  console.error(`setup: ${message}`);
  process.exit(1);
};

const status = await fetch(`${api}/setup/status`).catch(() => null);

if (!status?.ok) {
  fail(
    `${siteUrl} is not answering. Start it with: pnpm --filter @launch/emdash dev`
  );
}

const bypass = await fetch(`${api}/setup/dev-bypass`, {
  headers,
  method: "POST",
  redirect: "manual",
});

const cookie = bypass.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");

if (!cookie) {
  fail(`the dev bypass failed (HTTP ${bypass.status})`);
}

const forms = `${api}/plugins/emdash-forms`;

type FormsRoute = "forms/list" | "forms/create";

const call = async (route: FormsRoute, body: typeof demoForm | null = null) => {
  const response = await fetch(`${forms}/${route}`, {
    body: JSON.stringify(body ?? {}),
    headers: { ...headers, "content-type": "application/json", cookie },
    method: "POST",
  });

  if (!response.ok) {
    fail(`${route} failed (HTTP ${response.status}): ${await response.text()}`);
  }

  return response.text();
};

// The list holds each form's slug; a plain text check avoids typing the
// plugin's response for one lookup.
const list = await call("forms/list");

if (list.includes(`"slug":"${demoForm.slug}"`)) {
  console.log(`setup: the ${demoForm.slug} form already exists.`);
} else {
  await call("forms/create", demoForm);
  console.log(`setup: created the ${demoForm.slug} form.`);
}

console.log(
  `setup: done. Open ${siteUrl}/ for the site and ${siteUrl}/_emdash/admin to edit.`
);
