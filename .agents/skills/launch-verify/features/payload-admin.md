# Payload admin

An editor signs in to `/admin`, edits a page or post, sees the change in preview, and publishes it. On localhost the sign-in page offers **Continue as …**, which signs in as the first user without a password. It only answers requests from the same machine.

## Sub-features

- `sign-in`: create the first user on a fresh database, or **Continue as …**.
- `edit-page`: change a page's section and save a draft.
- `preview`: the preview button opens `/next/preview?path=…`, and the front end shows the draft only to the signed-in editor.
- `publish`: publishing makes the change visible to an anonymous visitor.

## How to get to it (user POV)

- **Admin** in the site header, or `/admin` directly.
- Collections in the admin sidebar: Pages, Posts, Forms, Form Submissions.

## Driving it with verify.ts

Preconditions: Payload is launched and seeded, and Doctor passes. Run `drive payload apply-form` once to create the local admin on a fresh database.

- **Sign in**: open `/admin` in a browser and click **Continue as verify@example.test** (or the seeded user). The dashboard lists the collections.
- **Edit, preview, publish (by hand)**: open Pages, then Programs, change a heading, and save a draft. Click Preview: the new heading shows. Then `capture payload /programs anonymous` must still show the old heading, because the capture is anonymous. Publish, and capture again: it shows the new heading.
- **Full editing smoke**: `pnpm --filter payload smoke http://localhost:4173` covers the first user, a media upload, a global, a draft page hidden from visitors, publishing, REST and GraphQL. Run it only against a fresh database, because it expects no users.

## Gotchas

- **Continue as …** is hidden behind a tunnel or on any non-local host. That's intended.
- `smoke` fails on a database where `apply-form` already created a user. Reset first (see Cleanup in SKILL.md).
