/**
 * Finishes local setup once `pnpm --filter @launch/emdash dev` answers: signs
 * in through EmDash's development-only setup bypass, which applies
 * seed/seed.json to the empty database (the dev server's own D1 and R2) and
 * leaves you signed in as the admin.
 *
 * The bypass answers 403 outside `astro dev`, so this cannot touch a deployed
 * site.
 */
const siteUrl = process.env.EMDASH_URL ?? "http://localhost:4321";
const api = `${siteUrl}/_emdash/api`;

const status = await fetch(`${api}/setup/status`).catch(() => null);

if (!status?.ok) {
  console.error(
    `setup: ${siteUrl} is not answering. Start it with: pnpm --filter @launch/emdash dev`
  );
  process.exit(1);
}

const bypass = await fetch(`${api}/setup/dev-bypass`, {
  // EmDash's CSRF check wants this header on every write.
  headers: { "X-EmDash-Request": "1" },
  method: "POST",
  redirect: "manual",
});

if (bypass.headers.getSetCookie().length === 0) {
  console.error(`setup: the dev bypass failed (HTTP ${bypass.status})`);
  process.exit(1);
}

console.log(
  `setup: seeded. Open ${siteUrl}/ for the site and ${siteUrl}/_emdash/admin to edit.`
);
