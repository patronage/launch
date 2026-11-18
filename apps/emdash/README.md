# @launch/emdash

A Launch site on [EmDash](https://github.com/emdash-cms/emdash), Cloudflare's Astro-based CMS. One Astro app on one Worker renders the site with `@launch/ui`'s shared sections and serves EmDash's admin (`/_emdash/admin`), REST API (`/_emdash/api`) and MCP endpoint. See [ADR 0022](../../docs/adr/0022-emdash-renders-the-site-in-astro.md).

```sh
pnpm --filter @launch/emdash dev      # http://localhost:4321, local D1, R2 and KV (runs in the background)
pnpm --filter @launch/emdash setup    # once, with dev running: applies the seed and creates the demo form
pnpm exec astro dev stop              # from this folder, to stop the dev server
```

`dev` first writes `.env.local` with a random `EMDASH_PREVIEW_SECRET` if there is none. `setup` signs in through EmDash's dev bypass (only `astro dev` has it), which applies `seed/seed.json` to a fresh database. `setup` then creates the demo form through the forms plugin's admin API. Local data lives in `.cloudflare/state/`; stop the server and delete it to start over.

To open the admin locally, go to http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin, which signs you in on the dev server only.

## Layout

- `src/pages/[...slug].astro`: every page by slug; `/` is the `home` page, and `/home` redirects there with its query string (EmDash links the home page's preview to `/home`). `getEmDashEntry` returns the published values, or the draft for a valid preview link. `src/pages/404.astro` handles the rest.
- `src/components/page-view.tsx`: the page's hero and sections, through `@launch/adapter-emdash` to `PageSections`. React renders on the server only; nothing hydrates.
- `src/layouts/site.astro` and `src/components/site-chrome.tsx`: fonts, the stylesheet, EmDash's SEO head, and the header and footer with the site title, tagline and `primary` menu.
- `src/components/form-section.astro`, `form-section-frame.tsx` and `src/lib/runs.ts`: `form` sections. The page renders in runs split at each form section, so the plugin's Astro form sits between sections the shared UI draws.
- `src/middleware.ts`: points the home page's sitemap entry at `/`, and points public pages and sitemaps at `/media/{key}` and `/forms/submit` instead of paths under `/_emdash`, which Access covers. This includes `og:image` and form actions.
- `src/pages/forms/submit.ts`: public form submissions. It rewrites to the forms plugin's public submit route.
- `src/styles/global.css`: `@launch/ui`'s Tailwind entry, built with `@tailwindcss/vite`.
- `src/pages/media/[...key].ts`: public media. It rewrites to EmDash's `/_emdash/api/media/file/{key}`, which refuses backup and staging keys.
- `src/worker.ts`: EmDash's Worker entry, plus the scheduled handler that publishes scheduled entries.

## Content

`seed/build.ts` writes `seed/seed.json`: the `pages` collection, its block types and the Neighborhood Growers demo pages, the same invented site as the WordPress and Payload seeds. Change the builder, not the JSON:

```sh
pnpm --filter @launch/emdash seed:write
```

`pnpm test` fails while `seed.json` is stale. Seed images download from `packages/demo-content/images` on GitHub (`raw.githubusercontent.com`), because EmDash refuses to fetch media from private addresses such as `localhost`. A new image only resolves once it is on `main`.

A page has a hero (a variant plus the fields each variant draws, as in the Payload and WordPress models) and a `sections` field of these blocks, each with the shared Section options: `content`, `content_media`, `media`, `card_grid`, `blockquote`, `call_to_action` and `form`. Not yet modeled: pull quotes, embeds and buttons inside rich text.

The seed also adds three example redirects: `/gardens` (301 to `/programs`), `/volunteer` (302 to `/get-involved`) and `/resources/[...path]` (301 to `/guide`).

## Redirects

EmDash's own redirects, managed in the admin under Redirects. They run in EmDash's middleware before any page:

- 301, 302, 307, 308, 410 and 451.
- Exact paths and Astro-style patterns (`[param]`, `[...rest]`). There are no regex patterns.
- Changing a published entry's slug adds a 301 from the old URL.
- Missed URLs go to a 404 log in the admin, to turn into redirects.

## SEO

- Each page has EmDash's SEO panel: title, description, social image, canonical and noindex.
- `<EmDashHead>` in `src/layouts/site.astro` writes the meta description, robots, canonical, Open Graph and Twitter tags and JSON-LD, with the panel's values over the page's defaults. The canonical URL comes from the site URL setting, else the request's origin, and never carries a query string.
- EmDash serves `/sitemap.xml` (with `/sitemap-pages.xml`) and `/robots.txt`, which disallows `/_emdash/`. Set the site URL under Settings so both use the production domain.

## Forms

[`@emdash-cms/plugin-forms`](https://www.npmjs.com/package/@emdash-cms/plugin-forms) builds forms in the admin (Plugins > Forms), validates and stores submissions (Plugins > Submissions), sends notifications and takes honeypot or Turnstile spam protection. A `form` section places a form on a page by its slug. The plugin renders the form with its own script; `src/styles/global.css` gives it the shared UI's colors and radii.

The demo form, `garden-application`, is defined in `seed/form.ts` and sits on the Apply page. Email notifications go through Cloudflare Email Sending when `EMAIL_FROM` is set at deploy (see Deploying); without it, submissions still land in the inbox.

## Previews

Pages have drafts. EmDash's Preview button opens `/{slug}?_preview=<token>`. The token is signed with `EMDASH_PREVIEW_SECRET` and names one entry, so it shows only that entry's draft. A preview page carries a banner and `Cache-Control: private, no-store`.

## Deploying

```sh
pnpm --filter @launch/emdash run deploy             # astro build, then cf deploy --prebuilt
pnpm --filter @launch/emdash run deploy --dry-run
pnpm --filter @launch/emdash run secrets            # EMDASH_PREVIEW_SECRET from the environment
```

It deploys as the Worker `launch-emdash` (`WORKER_NAME` overrides it), configured in `cloudflare.config.ts` with D1 (`DB`), R2 (`MEDIA`), KV (`SESSION`), the Images binding and a cron trigger every minute for scheduled publishing. Set at build time:

- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (required): EmDash signs editors in through the Cloudflare Access application, which must cover `/_emdash/*` and nothing else, so the site stays public (ADR 0011). The deploy refuses to run without them. Pages link media at `/media/{key}`, which `src/pages/media` hands to EmDash's file route, so images load outside Access. Forms post to `/forms/submit` for the same reason.
- `WORKER_DOMAIN`: the custom domain; without it the Worker is on workers.dev.
- `EMAIL_FROM`: the sender address for form notifications, magic links and invites. It turns on EmDash's Cloudflare email plugin and an `EMAIL` (`send_email`) binding limited to that address. Its domain must be onboarded for Cloudflare Email Sending. Without it, forms still save submissions but nothing is emailed.

There are no Worker Previews: the D1 database and R2 bucket are shared, so a preview would edit production content. The bundle is about 5 MB gzipped, so it needs the Workers Paid plan.

This app uses `@astrojs/cloudflare` 15 (beta), the first version that reads `cloudflare.config.ts` instead of a Wrangler file, and cf 1.0 rc, which reads the Build Output v1 it writes. The other apps stay on cf beta and Build Output v0 until those reach a release.
