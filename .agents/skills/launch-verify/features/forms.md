# Forms

A visitor fills in a CMS-defined form section, sends it, sees the form's confirmation, and the CMS stores the submission. On Payload the seeded forms are the garden application on `/apply` and the volunteer sign-up on `/get-involved`. On WordPress, form sections post through the front end to Formidable Forms.

## Sub-features

- `apply`: the garden application on `/apply` (Payload): seven fields, two selects and a checkbox.
- `volunteer`: the volunteer sign-up on `/get-involved`.
- `required`: required fields block an empty submit in the browser.
- `stored`: the submission appears in the CMS (Payload Form Submissions, Formidable entries).

## How to get to it (user POV)

- Home page, then **Apply now** in the call to action, to `/apply`.
- Header or home page links to **Get involved**.
- A direct visit to `/apply` or `/get-involved`.

## Driving it with verify.ts

Preconditions: Payload is launched and seeded, and Doctor passes.

- **Apply and confirm**: `node .agents/skills/launch-verify/scripts/verify.ts drive payload apply-form`. It fills each field with synthetic data carrying a run marker (`verify-xxxxxxxx`, `@example.test`), clicks **Send application** and expects `POST /forms/submit` with status 201, then the confirmation "Thanks for applying…" in an `<output>`.
- **Stored**: the same drive signs in as the local admin and reads `/api/form-submissions`. It creates `verify@example.test` when the database has no users, and otherwise uses the localhost-only **Continue as …** button. `form-submissions.json` holds the row with the marker, and `04-admin-submissions.png` shows the admin list.
- **Volunteer form or WordPress forms (by hand)**: open the page in a browser against the same origin, fill in synthetic values, send, and screenshot the confirmation. On WordPress, confirm the entry with `pnpm --filter cms-wordpress-headless wp -- eval 'echo count(FrmEntry::getAll([]));'` before and after.

## Gotchas

- Type only after `networkidle`. Input typed before hydration never reaches React state, and the form then submits nothing.
- Use only `@example.test` addresses. There's no email adapter, so form emails go to the server log, never out.
- Each run adds a real row to the local database. That's expected, and cleanup keeps it.
