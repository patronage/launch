# spike-vinext

Spike 1 ([issue #2](https://github.com/patronage/launch/issues/2)): a minimal vinext app on Cloudflare Workers, deployed with the `cf` CLI and no Wrangler config. Findings are in [`docs/spikes/02-vinext-on-workers.md`](../../docs/spikes/02-vinext-on-workers.md).

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
pnpm run deploy            # build, then cf deploy --prebuilt
pnpm run deploy --preview  # Preview build, then cf previews deploy (named after the branch)
pnpm run secrets           # set runtime secrets from the environment
pnpm run builds:configure  # connect this Worker to Workers Builds
```

Local secrets go in `.env.local` (gitignored):

```sh
REVALIDATE_SECRET=local-revalidate
PREVIEW_SECRET=local-preview
```

Deploying needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or a `cf auth login` session). Every script takes `--dry-run`. Pushes to the repo deploy through Workers Builds; see [`docs/spikes/11-workers-builds.md`](../../docs/spikes/11-workers-builds.md).
