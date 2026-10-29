# Payload

One Payload 4 (beta) app on Cloudflare Workers, built with [vinext](https://github.com/cloudflare/vinext) instead of Next.js. The admin, REST and GraphQL APIs and the public pages are a single Worker. The public pages read content through Payload's Local API.

- Database: D1, which is the chosen database for the demo. Postgres through Hyperdrive is an option (`PAYLOAD_DB=postgres`).
- Media: R2
- Collections: `users`, `pages` (drafts on, nested with the nested-docs plugin), `media`; global: `site-settings`
- Page sections: the `layout` blocks field holds one block per section type in `@launch/content-model` (`content`, `contentMedia`, `media`, `cardGrid`, `blockquote`, `callToAction`), each with a shared `sectionOptions` group. Field names match the content model and the WordPress ACF page builder, so `@launch/adapter-payload` only maps rich text, links and media.

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

### Demo content

`pnpm seed` creates the invented Neighborhood Growers site that the WordPress seed also creates: a home page with every section type (plus one hidden section), the pages it links to (`get-involved`, `apply`, `guide`, `programs`, `programs/seed-library`, `programs/tool-share`), five placeholder images from `packages/demo-content`, and the site settings. Pages are published. Running it again resets that content without duplicating it: pages match by slug and images by alt text. It works with `PAYLOAD_DB=postgres` too.

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

## How it fits together

- `src/app/(frontend)/[[...slug]]/page.tsx` serves every page by path. It reads the page through the Local API at depth 1 (`src/lib/page-query.ts`), checks the path against its nested-docs breadcrumbs, and renders the layout blocks with `PageSections` from `@launch/ui` through `@launch/adapter-payload`. Pages without blocks show the hero and rich text. `/` lists the pages until one has the slug `home`.
- `src/app/(frontend)/media/[...path]` serves media resized by the Cloudflare Images binding (`@launch/images`). It gets the original from Payload's own file endpoint in-process, so Payload keeps its R2 keys and access rules. vinext's `/_next/image` only resizes files in `public/` on Workers.

- `cloudflare.config.ts` declares the Worker and its bindings for the `cf` CLI and the Cloudflare Vite plugin. There is no Wrangler config.
- `src/payload.config.ts` reads bindings from `cloudflare:workers`. `src/db.ts` picks the adapter. Vite replaces `PAYLOAD_DB` at build time, so the bundle only carries one adapter.
- The Payload CLI runs in Node. `pnpm payload` loads `scripts/register-node-hooks.mjs`, which resolves `cloudflare:workers` to Miniflare bindings that share local state with `vite preview`.
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
| `pnpm deploy` | `vinext-cloudflare deploy` (not yet exercised, see Spike 1) |
