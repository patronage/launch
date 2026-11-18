# ADR 0022: EmDash renders its own site in Astro, with the shared sections

## Status

Accepted, 2026-11-17.

## Context

EmDash is Cloudflare's CMS, an Astro integration that runs on Workers with D1 and R2. Launch needs an EmDash reference beside WordPress and Payload. EmDash's own pattern is to render the site in the same Astro app, with live previews and visual editing built in. Launch's sites share `packages/ui` through a CMS-neutral content model ([ADR 0008](0008-cms-neutral-content-model.md)), and every CMS admin sits behind Cloudflare Access ([ADR 0011](0011-cms-behind-cloudflare-access.md)).

## Decision

- One Astro app, `apps/emdash`, on one Worker, serves the site and EmDash's admin, REST API and MCP. It is not a headless CMS behind a vinext front-end: the vinext rule in [ADR 0005](0005-vinext-front-ends-on-workers.md) doesn't apply to it.
- Pages render on the server with `@launch/ui`'s React components (`PageSections`, the site header and footer), through `packages/adapter-emdash`. Nothing hydrates.
- The schema is code: `seed/build.ts` writes the seed EmDash applies on a fresh database. Pages hold a hero and a `sections` field of block types that mirror the content model's sections, with the shared Section options on each.
- Previews are EmDash's own: its signed `_preview` link renders that entry's draft, and only that entry, with `Cache-Control: private, no-store`.
- Editors sign in through Access with EmDash's `access()` auth, configured when `ACCESS_TEAM_DOMAIN` is set at build time. The deploy script refuses to deploy without it. The Access application covers `/_emdash/*` only, so the site stays public. Pages link media at `/media/*`, which rewrites to EmDash's public file route.
- A cron trigger runs every minute, which is how EmDash publishes scheduled entries on Workers.
- The app uses `@astrojs/cloudflare` 15 (beta) and cf 1.0 rc, the first versions that configure an Astro Worker from `cloudflare.config.ts` with no Wrangler file ([ADR 0003](0003-cloudflare-config-through-cf-cli.md)). `@launch/worker-scripts` reads Build Output v1 (since every app moved to cf 1.0.0-rc.1, which rejects v0, it reads only v1).
- No Worker Previews, since a preview would share production's D1 database and R2 bucket.

## Consequences

- Edits show as soon as they are published; there is no front-end cache to revalidate.
- The site reads D1 on every request. Page caching (Astro's route cache with EmDash's cache hints) is a later step.
- Two Astro-adapter pins sit on prerelease versions until they ship.
- The EmDash seed covers fewer section types than WordPress and Payload (no forms, pull quotes, embeds or rich-text buttons), so its fixtures stay out of the sections parity test until it catches up.
