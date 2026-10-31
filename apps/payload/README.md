# Payload

One Payload 4 (beta) app on Cloudflare Workers, built with [vinext](https://github.com/cloudflare/vinext) instead of Next.js. The admin, REST and GraphQL APIs and the public pages are a single Worker. The public pages read content through Payload's Local API.

- Database: D1, which is the chosen database for the demo. Postgres through Hyperdrive is an option (`PAYLOAD_DB=postgres`).
- Media: R2
- Collections: `users`, `pages` (drafts on, nested with the nested-docs plugin), `posts` with `authors` and `categories`, `media`, and `forms` and `form-submissions` from the form-builder plugin; global: `site-settings`
- Preview: pages and posts autosave drafts, and editors see them through the admin's preview button and Live Preview (see below)
- MCP: Payload's MCP plugin serves read-only tools at `/api/mcp` to signed-in users (`src/mcp.ts`). With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, a verified Access JWT signs the caller in as the user with the same email. See [the spike note](../../docs/spikes/14-payload-mcp-plugin.md).
- MCP gateway: with `ACCESS_GATEWAY_AUD` (the gateway's Access application) and the `ACCESS_GATEWAY_PROOF_SECRET` secret set, the gateway in `apps/mcp` can call `/api` as an editor. It forwards the editor's Access JWT in `X-Access-User-Jwt`, and Payload trusts it only beside a gateway proof signed with that secret, because a Service binding never crosses Access. `ACCESS_GATEWAY_AUD` must be set at build time too, or the secret binding is left out. The gateway's writes are drafts only (see `apps/mcp/README.md`).
- Page sections: the `layout` blocks field holds one block per section type in `@launch/content-model` (`content`, `contentMedia`, `media`, `cardGrid`, `blockquote`, `callToAction`, `form`), each with a shared `sectionOptions` group. Field names match the content model and the WordPress ACF page builder, so `@launch/adapter-payload` only maps rich text, links and media.

Findings and open problems are in [docs/spikes/05-payload-on-vinext.md](../../docs/spikes/05-payload-on-vinext.md).

## Requirements

Node 24.22.1 or later (Payload 4's minimum) and pnpm 12.

## Local setup

```bash
cp .env.example .env        # set PAYLOAD_SECRET
cp .env .dev.vars           # the Worker reads secrets from .dev.vars
pnpm payload migrate        # create the local D1 schema
pnpm seed                   # optional: the demo site (see below)
pnpm build && pnpm preview  # http://localhost:4173/admin
```

On `localhost`, the admin's login page shows "Continue as …", which signs in as the first user without a password (a POST to `/next/local-login` from that page). It only answers requests made on the same machine: through a tunnel or on a deployed Worker, the button is hidden and the route returns 404.

### Demo content

`pnpm seed` creates the invented Neighborhood Growers site that the WordPress seed also creates: a home page with every section type (plus one hidden section), the pages it links to (`get-involved`, `apply`, `guide`, `programs`, `programs/seed-library`, `programs/tool-share`), five placeholder images from `packages/demo-content`, and the site settings. Pages are published. It also seeds two forms (a garden application on `apply` and a volunteer sign-up on `get-involved`) and the news: three authors, four categories and six posts. One post is a draft, and one published post has a newer draft, so preview and version history have something to show. Every page but the home page and the tool share has a hero, one of each variant (the starter guide's is the free-form one), and the guide and three posts use the rich-text blocks: buttons, an image, a pullquote and video and X embeds. Running it again resets that content without duplicating it: pages, posts and categories match by slug, authors by name and images by alt text. It works with `PAYLOAD_DB=postgres` too.

The seed lives in `src/seed/`: `content.ts` is the page content, `lexical.ts` builds the rich text.

After changing the seed or the blocks, `pnpm record-fixture` writes the seeded home page, read exactly as the front end reads it, to `packages/adapter-payload/fixtures/home.json`, so the parity test in `packages/sections-preview` compares real Payload output with WordPress's.

`vite dev` does not work yet with Payload 4 (see the spike notes), so the loop for now is build and preview.

`pnpm smoke` drives a browser through the admin against a fresh preview: first user, media upload to R2, a global, a draft page hidden from anonymous visitors, publishing, REST and GraphQL.

### Postgres

Run Postgres locally (Hyperdrive's local proxy needs a password in the URL), then:

```bash
export PAYLOAD_DB=postgres POSTGRES_URL=postgres://postgres:postgres@localhost:5432/launch_payload
pnpm payload migrate
pnpm build && pnpm preview
```

## Deploy

Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for the target account, plus a fresh `PAYLOAD_SECRET` for the remote Worker, then run from this app:

```sh
pnpm run deploy --dry-run   # build and check without uploading secret values
pnpm run deploy             # first production deploy, with PAYLOAD_SECRET in the environment
pnpm run secrets --dry-run  # build and list secret names only
pnpm run secrets            # update runtime secrets once the Worker exists
```

The deploy uses `cf deploy --prebuilt`. On the first production deploy, it passes the declared secrets from the environment through stdin, because `cf` cannot set secrets before the Worker exists. Dry runs exclude their values. Later deploys without values in the environment retain the stored secrets; keep them out of Workers Builds variables. `pnpm run secrets` updates them separately once the Worker exists. Both commands suppress output when uploading values and report only names or a failure exit status; check authentication and retry on failure.

After the first deploy, record the provisioned D1 database id and R2 bucket in `cloudflare.config.ts`. The Worker applies pending migrations on its first request. Open `/admin` to create the first user. This runs live as `launch-payload` (2026-10-30), with the D1 id pinned. Two Workers-only fixes keep it running:

- `src/lib/payload-config.ts` loads the config on the first request, not at startup, because the eager load read D1 during startup validation.
- `src/lib/worker-crypto.ts` hashes passwords with PBKDF2 through `@noble/hashes`, because Workers' native crypto caps the iteration count below Payload's.

`scripts/config-startup.test.mjs` covers both. Re-test remote sign-up and login after each Payload upgrade. Not yet checked live: the full editing and GraphQL flow that `pnpm smoke` covers locally, which must not run against the seeded production database.

`pnpm run deploy --preview` uploads a Worker Preview for the current branch. The D1 and R2 bindings currently use the same names as production: treat them as shared data. Run `pnpm smoke` only against a fresh, isolated database, because it creates and changes content.

Branch builds are off by default. To opt in, set `WORKER_PREVIEWS=true` when configuring Builds and protect every preview admin/API hostname with Access first. Version preview URLs are disabled to keep the CMS behind its protected hostnames. Before enabling branch builds, export a `PAYLOAD_SECRET` for previews and run `pnpm run secrets --preview-base` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Production secrets do not populate [Previews Base](https://developers.cloudflare.com/workers/previews/configuration/#secrets). New previews inherit its secrets; changing the base does not update existing previews. `--dry-run` still lists only names and sends no request.

`pnpm run builds:configure` connects an existing Worker to Workers Builds and refuses to enable optional branch builds until its Preview base secrets exist. It needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `BUILD_TOKEN_UUID`, `GITHUB_OWNER_ID` and `GITHUB_REPO_ID`. Optional `PAYLOAD_DB`, `HYPERDRIVE_ID` and `WORKER_DOMAIN` become build variables. It runs a frozen install and lint for the workspace, followed by typechecks and tests for this app and its dependencies. See [Workers Builds](../../docs/spikes/11-workers-builds.md) for the setup sequence.

## How it fits together

- `src/app/(frontend)/[[...slug]]/page.tsx` serves every page by path. It reads the page through the Local API at depth 1 (`src/lib/page-query.ts`), checks the path against its nested-docs breadcrumbs, and renders the layout blocks with `PageSections` from `@launch/ui` through `@launch/adapter-payload`. Pages without blocks show the hero and rich text. `/` lists the pages until one has the slug `home`.
- `src/app/(frontend)/news` lists published posts, featured first, then newest first. Each post is at `/news/<slug>`. A top-level page with the slug `news` would be hidden behind the listing.
- Forms: the `form` section renders `Form` from `@launch/ui`, which posts `{ formId, values }` to `src/app/(frontend)/forms/submit`. That route keeps only the form's own fields, checks required ones and creates the submission with the visitor's access. Field types are limited to those the UI draws. Confirmation messages work; redirect confirmations and email delivery are not wired up yet (without an email adapter, form emails go to the log). WordPress has no `form` section yet.
- Local sign-in: `src/lib/local-login.ts` treats a request as local when its host is localhost, miniflare's `cf-connecting-ip` and `x-forwarded-host` (when present) are loopback and localhost, and it carries no `cf-ray`, `cf-visitor`, `forwarded` or `x-forwarded-for` header, which Cloudflare's edge and tunnels add. `vite.config.ts` puts the real peer address in `cf-connecting-ip` when it is not loopback, because miniflare keeps a client-sent value. The route takes a same-origin POST only, then issues the same session and token as Payload's own login.
- Preview: the preview button and Live Preview open `/next/preview?path=…` (`src/lib/preview.ts`). For a logged-in editor, that route turns on draft mode and redirects to the path. Front-end reads pass `draft: true` only when draft mode is on and the reader is logged in (`src/lib/payload.ts`), so the cookie alone shows nothing. In Live Preview, `LivePreviewRefresh` re-renders the page each time the document autosaves.
- `src/app/(frontend)/media/[...path]` serves media resized by the Cloudflare Images binding (`@launch/images`). It gets the original from Payload's own file endpoint in-process, so Payload keeps its R2 keys and access rules. vinext's `/_next/image` only resizes files in `public/` on Workers.

- `cloudflare.config.ts` declares the Worker and its bindings for the `cf` CLI and the Cloudflare Vite plugin. There is no Wrangler config.
- `src/payload.config.ts` reads bindings from `cloudflare:workers`. `src/db.ts` picks the adapter. Vite replaces `PAYLOAD_DB` at build time, so the bundle only carries one adapter.
- The Payload CLI runs in Node. `pnpm payload` loads `scripts/register-node-hooks.mjs`, which resolves `cloudflare:workers` to Miniflare bindings that share local state with `vite preview`. The D1 and R2 bindings come from `cloudflare.config.ts`, because Miniflare keys local D1 files by database id. If `pnpm seed` ran before that change and the admin is empty, delete `.cloudflare/state` and migrate and seed again.
- Schema push is off: drizzle-kit cannot load in workerd. Use `pnpm payload migrate:create` after changing collections. The deployed Worker applies pending migrations on boot (`prodMigrations`).
- `src/request-scoped-pg.ts` gives Payload a `pg.Pool` that opens one connection per checkout. workerd ties sockets to the request that opened them.
- `src/og-stub.ts` replaces `next/og`, used only by Payload's admin OG image route. That keeps about 1 MB (gzipped) of wasm out of the Worker.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | Build the Worker into `.cloudflare/output` |
| `pnpm preview` | Run the built Worker locally in workerd |
| `pnpm payload <command>` | Payload CLI (`migrate`, `migrate:create`, `generate:types`, ...) |
| `pnpm seed` | Create or reset the demo pages, images and settings |
| `pnpm generate` | Regenerate `payload-types.ts` and the admin import map |
| `pnpm record-fixture` | Record the seeded home page as the Payload adapter's fixture |
| `pnpm smoke [url]` | Browser smoke test against a fresh database |
| `pnpm typecheck` | Generate Worker types and run `tsc` |
| `pnpm run deploy [--preview] [--dry-run]` | Build, then deploy the prebuilt Worker with `cf` |
| `pnpm run secrets [--preview-base] [--dry-run]` | Upload production or Preview base secrets from the environment; dry run lists only names |
| `pnpm run builds:configure [--dry-run]` | Configure production and branch preview builds for the existing Worker |
