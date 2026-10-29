# Spike 1: vinext on Workers without Wrangler config

Issue: [#2](https://github.com/patronage/launch/issues/2). App: [`apps/spike-vinext`](../../apps/spike-vinext).

## Answer

Yes. vinext 1.4 deploys to Workers through the new `cf` CLI with no Wrangler at all: Wrangler is not even in the dependency tree. Worker settings live in `cloudflare.config.ts`, the `cf` CLI's typed config file, and `cf deploy --prebuilt` uploads the Cloudflare Build Output that `vite build` writes to `.cloudflare/output/`. This is now vinext's default setup (`create-vinext-app` and `vinext init --platform=cloudflare`); the Wrangler path is the opt-in `--legacy-wrangler-cloudflare-init`.

Every feature the front-ends need worked in local workerd (`vite preview`), with one caveat on remote images and one on edge caching, below. A live deploy has not been run yet because this environment has no Cloudflare credentials; `pnpm run deploy --dry-run` passes, so the remaining step is one run with a token.

## Versions tested

vinext 1.4.0, @vinext/cloudflare 1.3.0, cf 1.0.0-beta.25, @cloudflare/vite-plugin 2.0.0-beta.v.8, Vite 8.3.0, React 19.3.1, TypeScript 7.0.2. `cf` and the Vite plugin v2 are both betas.

## Results

| Feature | Result | Notes |
| --- | --- | --- |
| App Router page | Works | |
| Dynamic route | Works | ISR needs `generateStaticParams` (it may return `[]`), the same rule as Next.js. Without it the route renders on every request with `no-store`. |
| API routes | Works | |
| ISR (`revalidate`) | Works | Served from KV: `x-vinext-cache: MISS`, then `HIT` with `s-maxage`. |
| `revalidateTag` | Works | A tag set with `cacheTag()` inside `"use cache"`, or with `fetch(url, { next: { tags } })`, also invalidates every ISR page built from that data. One call refreshes both. |
| `revalidatePath` | Works | |
| Draft mode | Works | `draftMode().enable()` sets `__prerender_bypass`. Draft requests skip the cache (`no-store`) and never write to it; anonymous requests still get the cached page. |
| `fetch` caching | Works | Tagged fetches are shared across pages and cleared by `revalidateTag`. |
| `next/image`, local | Works | `/_next/image` resizes through the Images binding (AVIF/WebP, immutable cache headers), simulated locally. |
| `next/image`, remote | Partial | Remote URLs go through `@unpic/react`, which rewrites them to the source CDN's own resize parameters when it recognises the host, and does not use the Images binding. Spike 3 (headless WordPress) should check what this does with WordPress media URLs; the likely fix is a custom `loader` that uses Cloudflare image transformations. |
| Plain-text vars | Works | `bindings.text(value)` in `cloudflare.config.ts`. Read with `import { env } from "cloudflare:workers"`; also mirrored onto `process.env`. |
| Secrets | Works | `bindings.secret()` declares the name; values come from `.env.local` locally and from `cf deploy --secrets-file` at deploy time. |
| KV namespace | Works (dry run) | `cf deploy --provision` (on by default) creates it on first deploy, so there is no manual setup step. |

## Caching mode

`create-vinext-app` offers several page caches. The spike started with `workersCacheCdnAdapter()` (edge ISR in Workers Cache, purged by tag), but its pages came back uncached in local preview: Workers Cache is not simulated locally, and cacheability is decided by a deploy-time probe. That cannot be tested without an account.

The spike now uses the KV data adapter for both data and pages (`--cdn-cache data-cache --data-cache kv`). Everything is testable locally, and one `revalidateTag` clears data and pages together, which is the behaviour the CMS webhooks need. Once a deploy is possible, it is worth timing KV against Workers Cache on a real zone; switching is a change to `vite.config.ts` and `cloudflare.config.ts` only.

## Recommended deploy pattern for every Worker in this repo

1. Each Worker app has a `cloudflare.config.ts` (the `cf` CLI's config). No `wrangler.jsonc`, `wrangler.toml` or Wrangler dependency. Worker name, compatibility date and bindings live there; the account comes from `CLOUDFLARE_ACCOUNT_ID`, never from the file.
2. Secrets are declared by name with `bindings.secret()`. Values come from the shell or CI secrets at deploy time and from a gitignored `.env.local` locally.
3. Deploy is `vite build` followed by `cf deploy --prebuilt --secrets-file <temp file>`. `scripts/deploy.mjs` in the spike app does this: it reads the secret names from the built `worker.config.json`, fails if any value is missing, writes a temporary `0600` file, deploys, and deletes the file. It should move to a shared package once a second Worker exists.
4. CI authenticates with `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" token template covers it); people use `cf auth login`.
5. Typecheck with `cf workers types && tsc --noEmit`. Generated types land in `.cloudflare/types` and stay gitignored.

The `vinext-cloudflare deploy` wrapper also uses `cf`, but it cannot pass `--secrets-file`, so the repo script calls `cf deploy` directly. The wrapper is only needed for its cache warming flags, which the KV mode does not use.

Other resources outside a Worker's bindings (DNS, Access applications, custom domains) are a separate question for the Access spike; `cf` covers the whole Cloudflare API (`cf cli search "<task>"` finds the command), so those can be scripted the same way.

## Gaps and follow-ups

- Run one live deploy with an account token, and check ISR headers, KV provisioning and the Images binding on `workers.dev`.
- vinext build output marks routes that call `draftMode()` or `headers()` as "Unknown"; that is a build report label only, and the routes cached correctly at runtime.
- The upstream `fetch` to the public internet failed in this sandbox (no direct egress from workerd), so the fetch cache was tested against the Worker's own `/api/now`.
- When the workspace scaffold lands, the app's own `pnpm-lock.yaml`, `packageManager` and `pnpm.onlyBuiltDependencies` (for `workerd`) move to the root.
