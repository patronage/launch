# Spike 4: Payload as one app under vinext on Workers

Issue: [#5](https://github.com/patronage/launch/issues/5). Code: [`apps/payload`](../../apps/payload).

## Question

Can one Payload app (the admin, plus front-end pages that read through the Local API) run under vinext on Cloudflare Workers?

## Answer

Yes, in production builds. Payload 4.0.0-beta.6 builds with vinext 1.4 and runs in local workerd (`vite preview`), with D1 or with Postgres through Hyperdrive, and media on R2. A browser test (`pnpm smoke`) covers the admin end to end and passes on both databases. Payload 3.92 passed the same test before the app moved to the Payload 4 beta.

Two gaps remain. `vite dev` does not work yet, and nothing has been deployed to Cloudflare. Deploying waits on Spike 1's deploy pattern and an account token.

**Recommendation:** keep Payload as one vinext app on Workers, with D1 as the default database for the demo. Postgres through Hyperdrive works, but it needs the request-scoped pool described below. Until `vite dev` works, develop with build and preview, and raise the dev failures with vinext upstream.

**Decision (2026-10-29):** the Payload app uses D1. Postgres through Hyperdrive stays available behind `PAYLOAD_DB=postgres` and gets compared on real Workers once the app deploys. No performance difference has been measured yet. Local runs say nothing about network latency, which is where the two will differ.

## What was tested

Versions: Payload 4.0.0-beta.6, vinext 1.4.0, `@vinext/cloudflare` 1.3.0, `@cloudflare/vite-plugin` 2.0.0-beta.v.7, `cf` 1.0.0-beta.25, Vite 8.3, Node 24.22.

| Check | D1 | Postgres (Hyperdrive) |
| --- | --- | --- |
| `vite build` | Pass | Pass |
| Migrations applied by the Worker on boot (`prodMigrations`) | Pass | Pass |
| Payload CLI in Node (`migrate`, `migrate:create`, `generate:types`, `generate:importmap`) | Pass | Pass |
| Admin: create first user, sign in | Pass | Pass |
| Upload to R2, served back from `/api/media/file/*` | Pass | Pass |
| Edit a global | Pass | Pass |
| Draft page hidden from anonymous visitors on the front end, visible to a signed-in editor | Pass | Pass |
| Publish, then rich text, global and R2 image on the public page | Pass | Pass |
| REST and GraphQL | Pass | Pass |
| 20 to 30 concurrent public requests | Pass | Pass |
| `vite dev` | Fail | Not tried |
| Deploy to Cloudflare | Not tried | Not tried |

The Worker is about 2.4 MB gzipped with either database. Without the OG stub (below) it was 3.3 MB. Check both numbers against the current Workers size limits for the plan the demo runs on.

## Things that had to change

**Hyperdrive's connection string is I/O.** Reading `env.HYPERDRIVE.connectionString` while modules load throws "Disallowed operation called within global scope". The Payload config is built as the module loads, so the adapter reads it from a getter, which `pg` only calls when it connects.

**Sockets are tied to a request.** Payload keeps one `pg.Pool` for the life of the isolate. workerd ties a socket to the request that opened it, so a later request that picks up a pooled connection hangs until the runtime cancels it. `maxUses: 1` fixed sequential requests but not concurrent ones, because a released client could still be handed to a waiting request. `src/request-scoped-pg.ts` passes Payload a `Pool` subclass (through the adapter's `pg` option) that opens a connection per checkout and closes it on release. Hyperdrive does the real pooling. This should go upstream to Payload.

**No schema push.** Payload's dev-mode push loads drizzle-kit, which cannot run in workerd. Both adapters set `push: false`, and every environment uses migrations.

**The Payload CLI cannot import `cloudflare:workers`.** The config reads bindings from `cloudflare:workers`, which only exists in workerd. `pnpm payload` registers a Node module hook that resolves it to Miniflare bindings on the same local state as `vite preview`. Running the CLI against remote D1 is not solved yet. On deploy the Worker runs pending migrations on its first request, which adds that time to one cold start.

**`import.meta.dirname` is undefined in workerd.** The ultracite autofix rewrites `fileURLToPath(import.meta.url)` to it, which breaks the Worker. `payload.config.ts` keeps the URL form, with the lint rule disabled on that line.

**`next/og` is stubbed.** Payload's admin OG image route is the only importer, and it pulls in about 2 MB of resvg, yoga and harfbuzz wasm. With the alias, that route errors instead of rendering an image. Nothing else uses it.

**One adapter per bundle.** `PAYLOAD_DB` is replaced at build time, so the unused adapter is dropped. `cloudflare.config.ts` declares only the matching binding.

## `vite dev`

The server side got partway there, and the browser never hydrated the admin. In order:

1. React's development build calls `console.createTask`. With a 2025-09-21 or later compatibility date, workerd's native `node:console` throws on that call. The `disable_nodejs_console_module` flag fixes it.
2. The RSC optimizer pre-bundles Payload's `"use client"` modules separately from their originals, so React context ends up undefined. Excluding `@payloadcms/next`, `@payloadcms/ui` and `@payloadcms/richtext-lexical` from the `rsc` and `ssr` optimizers fixes that.
3. The browser then loads CommonJS dependencies of those packages unbundled (`bson-objectid`, `ajv`, `react/compiler-runtime`, ...). Listing them in `optimizeDeps.include` gets further, but more keep appearing.
4. On Payload 4 the admin fails during server rendering on vinext's `next/font/google` shim (`Inter is not a function`), and the front end fails on duplicate React.

None of these settings are in the committed config, because they did not get dev working. Next steps: report items 2 to 4 to vinext with a minimal reproduction. Also try running the admin under `next dev` in Node, with the same `cloudflare:workers` hook the CLI uses, as a dev-only fallback.

## Local API and `overrideAccess`

Payload 3 skips access control on Local API calls unless `overrideAccess: false` is passed. Payload 4 flips the default to `false`. Either way, every Local API call made for a visitor has to run with the visitor's access: front-end pages, route handlers and server actions. `src/lib/payload.ts` gets the user from the request headers, and each front-end call passes `user` and `overrideAccess: false` explicitly. That keeps the guarantee independent of the default. The draft test checks it.

`overrideAccess: true` belongs only in trusted server code: seeding, jobs, migrations and scripts.

## Configuration notes

- `vinext init` writes `cloudflare.config.ts`, the typed config for the `cf` CLI and Cloudflare Vite plugin v2. It is not a Wrangler file. It declares the Worker, bindings and secrets in code, and `vinext-cloudflare deploy` deploys with `cf`. Spike 1 should confirm that this fits the "configured through the Cloudflare CLI and API" rule.
- Payload 4 needs Node 24.22.1 or later. The repo pins Node 24, and `apps/payload` sets `engines` to `>=24.22.1`.
- The `cloudflare:workers` env types come from `cf workers types`, which `pnpm typecheck` runs first.
- Local Hyperdrive in Miniflare refuses a connection string without a password.

## Not covered

- Deploying to Cloudflare, real Hyperdrive, Workers Builds and previews (needs Spike 1 and an account)
- Cloudflare Access in front of `/admin` and `/api`
- Cold-start and CPU time on real Workers. In local workerd, warm public pages answered in about 30 ms.
- Image resizing. Upload crop and focal point are off because there is no `sharp` on Workers.
- Payload 4's built-in MCP. That belongs with the MCP spike.
