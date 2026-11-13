# Payload

One Payload 4 (beta) app on Cloudflare Workers, built with [vinext](https://github.com/cloudflare/vinext) instead of Next.js. The admin, REST and GraphQL APIs and the public pages are a single Worker. The public pages read content through Payload's Local API.

- Database: Postgres on PlanetScale through Hyperdrive in production (`PAYLOAD_DB=postgres`, [ADR 0020](../../docs/adr/0020-payload-production-on-planetscale.md)), once the move below is done; until then the live demo runs on D1. D1 stays the default for local work.
- Media: R2. The `media` collection takes pictures only (AVIF, GIF, JPEG, PNG, WebP), which is also what the MCP gateway may upload to it. It names no hosts in `upload.pasteURL.allowList`, so the gateway takes no files for it by URL.
- Collections: `users`, `pages` (drafts on, nested with the nested-docs plugin), `posts` with `authors` and `categories` (pages and posts keep a trash: deleting one in the admin moves it there, where it can be restored), `media`, and `forms` and `form-submissions` from the form-builder plugin; global: `site-settings`
- Preview: pages and posts autosave drafts, and editors see them through the admin's preview button and Live Preview (see below)
- MCP: Payload's MCP plugin serves read-only tools at `/api/mcp` to signed-in users (`src/mcp.ts`). Beside the built-in reads, `src/mcp-tools.ts` adds `getEditingInfo` (for each collection and global the editor can read: drafts, rich text fields, array and blocks fields and what their rows hold, relationship and upload fields and whether each stores `{ relationTo, value }` (`polymorphic`), whether the collection keeps a trash, upload limits, the site's locales and the fields Payload keeps for each locale (`localizedFields`, for the document and for the rows of each array and blocks field, with `_status` among them where publishing is by locale), what the editor may create, update or delete, and whether another editor has a global open, read from Payload's lock documents by `src/lib/document-lock.ts`; the schema walk is in `src/lib/editing-info.ts`), `findGlobalDraft` on the site settings (the global's newest version, as the admin opens it, which Payload's own `findGlobal` tool cannot ask for; it takes `locale` and `fallbackLocale` like Payload's own reads, and refuses a locale the site does not have), `getDocumentLock` on every collection MCP can read (whether another editor has one document open, which the gateway asks before it restores a version, because Payload restores over a lock) and, on pages and posts, `markdownToRichText` and `richTextToMarkdown`, which convert with the field's own editor config and touch no document (an optional `path`, such as `["layout", "content", "body"]`, names a rich text field inside a row: field names from the top, with a block's slug after each blocks field), and `getPreviewUrl`, which gives the link the admin's Preview button opens for one document (`url`; with a `locale`, the link for that locale) and the path the public reaches the document at now (`path`, from its published version, null while it is not published). The plugin's own OAuth server is off (`oauth: false`), so an MCP client cannot sign in to Payload directly. With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, a verified Access JWT signs the caller in as the user with the same email. See [the spike note](../../docs/spikes/14-payload-mcp-plugin.md).
- MCP gateway: with `ACCESS_GATEWAY_AUD` (the gateway's Access application) and the `ACCESS_GATEWAY_PROOF_SECRET` secret set, the gateway in `apps/mcp` can call `/api` as an editor. It forwards the editor's Access JWT in `X-Access-User-Jwt`, and Payload trusts it only beside a gateway proof signed with that secret, because a Service binding never crosses Access. `ACCESS_GATEWAY_AUD` must be set at build time too, or the secret binding is left out. The gateway's writes are drafts only (see `apps/mcp/README.md`).
- Admin sign-in through Access: with `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, a verified Access JWT signs the editor in to the admin as the user with the same email, unless a working Payload session already does (`src/collections/users.ts`). Logging out works as in WordPress's `patronage-access`: it ends the Payload session and leaves the Access session alone. An `afterLogout` hook sets a one-hour, HttpOnly `<cookiePrefix>-access-off` cookie, and while the browser holds it the Access strategy steps aside, so the admin shows the login form. There the editor signs in with a password, or with **Sign in with Access as …**, which posts to `/next/access-sign-in` to clear the cookie (`src/lib/access-opt-out.ts`). The cookie can only make the strategy step aside, never sign anyone in, and the MCP gateway's calls ignore it. When it expires, Access signs the editor in again on the next visit. `patronage-access` 1.1.0 does the same in WordPress, with its own `patronage_access_off` cookie and button. Without Access, logging out is Payload's own.
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

### A second language, locally

The demo has one language. To try localized content, set `PAYLOAD_DEMO_LOCALES` to a list of locale codes, the default first, for every command of one local run:

```bash
export PAYLOAD_DEMO_LOCALES=en,es
pnpm migrate:create demo_locales && pnpm payload migrate && pnpm seed
pnpm build && pnpm preview
```

With it set, `src/demo-locales.ts` turns on Payload's `localization` and localizes a post's title, excerpt and content, each section's heading, a picture's alt text and the site's tagline. Payload then keeps a publish status for each locale of pages and posts. The schema differs from the committed one, so this mode keeps its own database, migrations and generated types under `.demo-locales/` (ignored by git) and leaves the normal local database alone; delete that folder to start over. It is D1 only, and `pnpm run deploy` refuses to run with the variable set: the committed migrations do not hold these tables. The `launch-verify` skill's `launch payload --locales` and `launch mcp --locales` do all of this for you.

### Demo content

`pnpm seed` creates the invented Neighborhood Growers site that the WordPress seed also creates: a home page with every section type (plus one hidden section), the pages it links to (`get-involved`, `apply`, `guide`, `programs`, `programs/seed-library`, `programs/tool-share`), five placeholder images from `packages/demo-content`, and the site settings. Pages are published. It also seeds two forms (a garden application on `apply` and a volunteer sign-up on `get-involved`) and the news: three authors, four categories and six posts. One post is a draft, and one published post has a newer draft, so preview and version history have something to show. Two redirects and the seed library's SEO text show those features, and the tool share is hidden from search engines. Every page but the home page and the tool share has a hero, one of each variant (the starter guide's is the free-form one), and the guide and three posts use the rich-text blocks: buttons, an image, a pullquote and video and X embeds. Running it again resets that content without duplicating it: pages, posts and categories match by slug, authors by name and images by alt text. It works with `PAYLOAD_DB=postgres` too.

The seed lives in `src/seed/`: `content.ts` is the page content, `lexical.ts` builds the rich text.

After changing the seed or the blocks, `pnpm record-fixture` writes the seeded home page, read exactly as the front end reads it, to `packages/adapter-payload/fixtures/home.json`, so the parity test in `packages/sections-preview` compares real Payload output with WordPress's.

`vite dev` does not work yet with Payload 4 (see the spike notes), so the loop for now is build and preview.

`pnpm smoke` drives a browser through the admin against a fresh preview: first user, media upload to R2, a global, a draft page hidden from anonymous visitors, publishing, REST and GraphQL.

### Postgres

`pnpm db` starts a local Postgres 17 from `docker-compose.yml` on port 5437 (Hyperdrive's local proxy needs a password in the URL, which the compose file sets). Then:

```bash
export PAYLOAD_DB=postgres POSTGRES_URL=postgres://postgres:postgres@localhost:5437/launch_payload
pnpm payload migrate
pnpm build && pnpm preview
```

`pnpm db:stop` stops it, and `pnpm db:recreate` deletes its data and starts it empty.

### Pull content from PlanetScale

`pnpm db:pull` replaces the local Postgres with the content of the PlanetScale database in `db-pull.env` (`launch-payload`, branch `main`; `--branch <name>` picks another). It needs Docker and the `pscale` CLI signed in (`pscale auth login`). Stop the preview server first. `--dry-run` prints the plan and contacts nothing; `--migrate` runs this checkout's pending migrations on the copy afterwards.

It reads through a temporary read-only PlanetScale role, which it deletes once the dump ends, and copies the rows of the `content` tables in `db-pull.tables` only. Users, sessions, admin preferences, form submissions and forms' notification emails stay in PlanetScale, so the copy has no users: open the admin on localhost and create the first one. `scripts/db-pull-after.mjs` then compares the copy's migrations with this checkout and `origin/main`, and prints `migrate:status`. A new collection, field or plugin table needs a line in `db-pull.tables`; `pnpm test` fails until it has one. Media stays in R2. The shared script and its settings are in [`packages/db-pull`](../../packages/db-pull/README.md).

### Move production from D1 to PlanetScale

`pnpm d1:copy` copies the production D1 database into an empty, migrated Postgres, table by table with the same ids. It reads D1 through `cf d1 query` (SELECTs only) with the cf CLI signed in, and writes everything in one transaction that commits only when every table's row count matches D1. Sessions, document locks and the key-value cache are not copied, so editors sign in again. `--local` copies the local D1 instead and `--dry-run` writes nothing. `D1_COPY_E2E=1 node --test scripts/d1-to-postgres-e2e.test.mjs` runs it end to end against a throwaway D1 and Postgres container, and checks that Payload reads the same documents from both.

The switch, from this app, with editing paused from step 3 to step 6:

1. `pnpm run hyperdrive:configure` creates the Hyperdrive configuration `launch-payload` with the managed PlanetScale integration (organization, database and branch from `db-pull.env`), turns caching off and prints its id. `--dry-run` only reads.
2. Create a short-lived PlanetScale admin role, and put its connection URL in `TARGET` (it stays in the shell, never in a file): `pscale role create launch-payload main d1-copy --inherited-roles postgres --ttl 1h --format json --org sysadmin-patronage`. Set the TTL: without one the role never expires.
3. With `PGOPTIONS='-c role=postgres'` exported, so the tables belong to `postgres` and not to the role you delete afterwards: `PAYLOAD_DB=postgres POSTGRES_URL="$TARGET" pnpm payload migrate`, then `pnpm d1:copy --target "$TARGET" --dry-run` and `pnpm d1:copy --target "$TARGET"`.
4. Add `PAYLOAD_DB=postgres` and `HYPERDRIVE_ID=<id>` to the existing production Workers Builds trigger with `cf builds triggers environment-variables upsert <trigger-uuid>` and rebuild with `cf builds create <trigger-uuid> --branch main` (the docs site's Workers Builds page shows how to find the trigger). `pnpm run builds:configure` only sets variables when it creates a trigger.
5. Check the public pages, sign in to the admin, then delete the role (`pscale role delete launch-payload main <role-id>`).
6. Resume editing.

To go back, set `PAYLOAD_DB` to `d1` on the trigger (the same upsert) and rebuild: D1 still holds the content as of step 3. Delete the D1 database only once Postgres has run for a while.

## Deploy

Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for the target account, plus a fresh `PAYLOAD_SECRET` for the remote Worker, then run from this app:

```sh
pnpm run deploy --dry-run   # build and check without uploading secret values
pnpm run deploy             # first production deploy, with PAYLOAD_SECRET in the environment
pnpm run secrets --dry-run  # build and list secret names only
pnpm run secrets            # update runtime secrets once the Worker exists
```

The deploy uses `cf deploy --prebuilt`. On the first production deploy, it passes the declared secrets from the environment through stdin, because `cf` cannot set secrets before the Worker exists. Dry runs exclude their values. Later deploys without values in the environment retain the stored secrets; keep them out of Workers Builds variables. `pnpm run secrets` updates them separately once the Worker exists. Both commands suppress output when uploading values and report only names or a failure exit status; check authentication and retry on failure.

After the first deploy, record the provisioned D1 database id and R2 bucket in `cloudflare.config.ts` (with `PAYLOAD_DB=postgres`, the database is the Hyperdrive configuration from `pnpm run hyperdrive:configure` instead). The Worker applies pending migrations on its first request. Open `/admin` to create the first user. That only works on `localhost`, or on the deployed Worker once Access protects `/admin` and `/api` and the Worker has `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`: Payload alone would let anyone who reached a fresh deploy first create that user, so `src/lib/first-user-guard.ts` requires a verified Access login with the same email. This runs live as `launch-payload` (2026-10-30), with the D1 id pinned. Two Workers-only fixes keep it running:

- `src/lib/payload-config.ts` loads the config on the first request, not at startup, because the eager load read D1 during startup validation.
- `src/lib/worker-crypto.ts` hashes passwords with PBKDF2 through `@noble/hashes`, because Workers' native crypto caps the iteration count below Payload's.

`scripts/config-startup.test.mjs` covers both. Re-test remote sign-up and login after each Payload upgrade. Not yet checked live: the full editing and GraphQL flow that `pnpm smoke` covers locally, which must not run against the seeded production database.

`pnpm run deploy --preview` uploads a Worker Preview for the current branch. The D1 and R2 bindings currently use the same names as production: treat them as shared data. Run `pnpm smoke` only against a fresh, isolated database, because it creates and changes content.

Branch builds are off by default. To opt in, create a D1 database and R2 bucket for previews, set `WORKER_PREVIEWS=true` with `PAYLOAD_PREVIEW_D1_ID`, `PAYLOAD_PREVIEW_D1_NAME` and `PAYLOAD_PREVIEW_R2_BUCKET` when configuring Builds, and protect every preview admin/API hostname with Access first. A Preview never binds the production database or bucket; a Preview build without its own fails. Once `WORKER_DOMAIN` is set, the Worker is served only there, not on `workers.dev`. Version preview URLs are disabled to keep the CMS behind its protected hostnames. Before enabling branch builds, export a `PAYLOAD_SECRET` for previews and run `pnpm run secrets --preview-base` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Production secrets do not populate [Previews Base](https://developers.cloudflare.com/workers/previews/configuration/#secrets). New previews inherit its secrets; changing the base does not update existing previews. `--dry-run` still lists only names and sends no request.

### Branch previews on Postgres

With `PAYLOAD_DB=postgres`, a Preview reads the PlanetScale branch `preview` through its own Hyperdrive configuration (`PAYLOAD_PREVIEW_HYPERDRIVE_ID`) and media bucket (`PAYLOAD_PREVIEW_R2_BUCKET`), never production's ([ADR 0021](../../docs/adr/0021-payload-previews-on-one-preview-database.md)). The branch's `public` schema is the shared preview copy. Before a preview build, `pnpm run deploy --preview` runs `node scripts/preview-schema.mjs prepare --branch <branch>` (the branch is `WORKERS_CI_BRANCH` in Workers Builds, else the checkout's):

- A branch that adds no migrations reads `public`. Nothing is created.
- A branch that adds migrations gets its own schema, `preview_<hash of the branch name>`, with `public`'s rows (preview users included) copied in and the branch's migrations run on top. The Worker is built with `PAYLOAD_DB_SCHEMA` set to it, and runs no migrations at boot. Later builds migrate the schema in place.

`prepare` needs `PREVIEW_DATABASE_URL`, a direct connection (port 5432, `sslmode=verify-full`) to the `preview` branch as a role that inherits `postgres`. On the Builds trigger it is a secret variable, added by hand. What the script creates belongs to `postgres`, so the role can be deleted. It refuses any database that has not been marked once with `node scripts/preview-schema.mjs init`. `drop --branch <name>` removes a branch's schema, and `sweep --days <n> [--dry-run]` drops schemas not prepared for that many days.

`PREVIEW_SCHEMA_E2E=1 node --test scripts/preview-schema-e2e.test.mjs` runs all of it against a throwaway Postgres in Docker.

`pnpm run builds:configure` connects an existing Worker to Workers Builds and refuses to enable optional branch builds until its Preview base secrets exist. It runs through your `cf auth login` and needs `CLOUDFLARE_ACCOUNT_ID`, `BUILD_TOKEN_UUID`, `GITHUB_OWNER_ID` and `GITHUB_REPO_ID`. Optional `PAYLOAD_DB`, `HYPERDRIVE_ID`, `WORKER_DOMAIN` and the `ACCESS_*` settings become build variables. They are copied onto the Builds trigger once, so a setting added later has to be added to the trigger too (see the docs site's Workers Builds page). It runs a frozen install and lint for the workspace, followed by typechecks and tests for this app and its dependencies. See [Workers Builds](../../docs/spikes/11-workers-builds.md) for the setup sequence.

## How it fits together

- `src/app/(frontend)/[[...slug]]/page.tsx` serves every page by path. It reads the page through the Local API at depth 1 (`src/lib/page-query.ts`), checks the path against its nested-docs breadcrumbs, and renders the layout blocks with `PageSections` from `@launch/ui` through `@launch/adapter-payload`. Pages without blocks show the hero and rich text. `/` lists the pages until one has the slug `home`.
- `src/app/(frontend)/news` lists published posts, featured first, then newest first. Each post is at `/news/<slug>`. A top-level page with the slug `news` would be hidden behind the listing.
- Forms: the `form` section renders `Form` from `@launch/ui`, which posts `{ formId, values }` to `src/app/(frontend)/forms/submit`. That route keeps only the form's own fields, checks required ones and creates the submission with the visitor's access. Field types are limited to those the UI draws. Confirmation messages work; redirect confirmations and email delivery are not wired up yet (without an email adapter, form emails go to the log).
- Local sign-in: `src/lib/local-login.ts` treats a request as local when its host is localhost, miniflare's `cf-connecting-ip` and `x-forwarded-host` (when present) are loopback and localhost, and it carries no `cf-ray`, `cf-visitor`, `forwarded` or `x-forwarded-for` header, which Cloudflare's edge and tunnels add. `vite.config.ts` puts the real peer address in `cf-connecting-ip` when it is not loopback, because miniflare keeps a client-sent value. The route takes a same-origin POST only, then issues the same session and token as Payload's own login.
- Preview: the preview button and Live Preview open `/next/preview?path=…` (`src/lib/preview.ts`). For a logged-in editor, that route turns on draft mode and redirects to the path. Front-end reads pass `draft: true` only when draft mode is on and the reader is logged in (`src/lib/payload.ts`), so the cookie alone shows nothing. In Live Preview, `LivePreviewRefresh` re-renders the page each time the document autosaves.
- SEO: `src/seo.ts` adds the SEO group to pages and posts, and `src/lib/seo.ts` turns it into metadata, with fallbacks to the document's own title, excerpt and hero. `src/app/sitemap.ts` and `src/app/robots.ts` serve `/sitemap.xml` and `/robots.txt`, using the request's hostname. `htmlLimitedBots` in `next.config.ts` keeps metadata in `<head>` for every user agent.
- Redirects: `src/redirects.ts` adds the collection. Routes call `followRedirect` (`src/lib/follow-redirect.ts`) just before `notFound()`, so a published page always wins. It reads as an anonymous visitor, so a redirect to a draft is ignored.
- `src/app/(frontend)/media/[...path]` serves media resized by the Cloudflare Images binding (`@launch/images`). It gets the original from Payload's own file endpoint in-process, so Payload keeps its R2 keys and access rules. vinext's `/_next/image` only resizes files in `public/` on Workers.

- `cloudflare.config.ts` declares the Worker and its bindings for the `cf` CLI and the Cloudflare Vite plugin. There is no Wrangler config.
- `src/payload.config.ts` reads bindings from `cloudflare:workers`. `src/db.ts` picks the adapter. Vite replaces `PAYLOAD_DB` at build time, so the bundle only carries one adapter.
- The Payload CLI runs in Node. `pnpm payload` loads `scripts/register-node-hooks.mjs`, which resolves `cloudflare:workers` to Miniflare bindings that share local state with `vite preview`. The D1 and R2 bindings come from `cloudflare.config.ts`, because Miniflare keys local D1 files by database id. If `pnpm seed` ran before that change and the admin is empty, delete `.cloudflare/state` and migrate and seed again.
- Schema push is off: drizzle-kit cannot load in workerd. Use `pnpm migrate:create <name>` after changing collections: it runs Payload's `migrate:create` for D1 and for Postgres (with `pnpm db` running). The deployed Worker applies pending migrations on boot (`prodMigrations`).
- Postgres migrations name no schema, so a branch preview can run them into its own (above). Payload's `migrate:create` writes `"public".` before enum and foreign-key names; `pnpm migrate:create` deletes that prefix from the new Postgres migration. If you run `pnpm payload migrate:create` directly, delete it yourself: `pnpm test` fails while any migration has it.
- `src/request-scoped-pg.ts` gives Payload a `pg.Pool` that opens one connection per checkout. workerd ties sockets to the request that opened them.
- `src/og-stub.ts` replaces `next/og`, used only by Payload's admin OG image route. That keeps about 1 MB (gzipped) of wasm out of the Worker.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | Build the Worker into `.cloudflare/output` |
| `pnpm preview` | Run the built Worker locally in workerd |
| `pnpm migrate:create <name>` | Write the D1 and Postgres migrations for a config change |
| `pnpm payload <command>` | Payload CLI (`migrate`, `migrate:create`, `generate:types`, ...) |
| `pnpm seed` | Create or reset the demo pages, images and settings |
| `pnpm generate` | Regenerate `payload-types.ts` and the admin import map |
| `pnpm record-fixture` | Record the seeded home page as the Payload adapter's fixture |
| `pnpm smoke [url]` | Browser smoke test against a fresh database |
| `pnpm typecheck` | Generate Worker types and run `tsc` |
| `pnpm run deploy [--preview] [--dry-run]` | Build, then deploy the prebuilt Worker with `cf` |
| `pnpm run secrets [--preview-base] [--dry-run]` | Upload production or Preview base secrets from the environment; dry run lists only names |
| `pnpm run builds:configure [--dry-run]` | Configure production and branch preview builds for the existing Worker |
