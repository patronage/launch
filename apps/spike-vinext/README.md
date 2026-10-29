# spike-vinext

Spike 1 ([issue #2](https://github.com/patronage/launch/issues/2)): a minimal vinext app on Cloudflare Workers, deployed with the `cf` CLI and no Wrangler config. Findings are in [`docs/spikes/01-vinext-workers.md`](../../docs/spikes/01-vinext-workers.md).

## Routes

| Route | What it exercises |
| --- | --- |
| `/` | App Router page, ISR (`revalidate = 300`) |
| `/posts/[slug]` | Dynamic route, ISR, `"use cache"` data with tags, tagged `fetch`, draft mode |
| `/images` | `next/image` with a static import, a public path and a remote URL |
| `/api/hello` | Route handler, plain-text binding, secrets, `process.env` |
| `/api/revalidate` | `POST ?tag=…&path=…` with `x-revalidate-secret` header |
| `/api/draft` | `GET ?secret=…&slug=…` enables draft mode; `?disable=1` turns it off |
| `/api/now` | A changing JSON response, handy as `UPSTREAM_URL` when testing the fetch cache |

## Scripts

```sh
pnpm dev         # vite dev (workerd)
pnpm build       # vite build -> .cloudflare/output (Cloudflare Build Output)
pnpm start       # vite preview: the built Worker in local workerd
pnpm typecheck   # cf workers types && tsc --noEmit
pnpm run deploy  # scripts/deploy.mjs: build, then cf deploy --prebuilt
```

Local secrets go in `.env.local` (gitignored):

```sh
REVALIDATE_SECRET=local-revalidate
PREVIEW_SECRET=local-preview
```

Deploying needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (or a `cf auth login` session), and the secret values in the environment. `pnpm run deploy --dry-run` checks everything without uploading.
