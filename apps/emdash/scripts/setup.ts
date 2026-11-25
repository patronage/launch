/**
 * Finishes local setup once `pnpm --filter @launch/emdash dev` answers:
 *
 * 1. Signs in through EmDash's development-only setup bypass, which applies
 *    seed/seed.json to the empty database (the dev server's own D1 and R2).
 * 2. Creates the demo form the Apply page places, through the forms plugin's
 *    admin API, unless it exists. The seed can't hold plugin data.
 * 3. Dates the demo news stories (seed/news-dates.ts). EmDash's seed stamps
 *    every entry with the time it is applied.
 *
 * The bypass answers 403 outside `astro dev`, so this cannot touch a deployed
 * site. Run it again any time.
 */
import { demoForm } from "../seed/form.ts";
import { newsDates } from "../seed/news-dates.ts";

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

// News dates ------------------------------------------------------------------

interface NewsItem {
  id: string;
  slug: string | null;
  publishedAt: string | null;
}

const newsList = await fetch(`${api}/content/news?limit=100`, {
  headers: { ...headers, cookie },
});

if (!newsList.ok) {
  fail(`listing news failed (HTTP ${newsList.status})`);
}

// SAFETY: EmDash's content list answers { data: { items } } with each entry's
// id, slug and publishedAt; only those are read.
const { data } = (await newsList.json()) as { data: { items: NewsItem[] } };

// Published stories only, and only while they still carry the seed's time.
const undated = data.items.flatMap((item) => {
  const date = item.slug ? newsDates.get(item.slug) : undefined;

  return date && item.publishedAt && item.publishedAt !== date
    ? [{ date, item }]
    : [];
});

await Promise.all(
  undated.map(async ({ date, item }) => {
    const response = await fetch(`${api}/content/news/${item.id}`, {
      body: JSON.stringify({ publishedAt: date }),
      headers: { ...headers, "content-type": "application/json", cookie },
      method: "PUT",
    });

    if (!response.ok) {
      fail(
        `dating ${item.slug} failed (HTTP ${response.status}): ${await response.text()}`
      );
    }
  })
);

console.log(`setup: dated ${undated.length} news stories.`);

console.log(
  `setup: done. Open ${siteUrl}/ for the site and ${siteUrl}/_emdash/admin to edit.`
);
