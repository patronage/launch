# docs-site

The public docs for Launch, built with [Blume](https://useblume.dev) and served as a static, assets-only Cloudflare Worker named `launch-docs`.

```sh
pnpm --filter docs-site dev     # http://localhost:4321
pnpm --filter docs-site build   # static site in dist/
pnpm --filter docs-site start   # serve the last build
```

## Content

- `docs/`: the pages. Folders are sidebar groups; `meta.ts` sets a group's title and order.
- `docs/research/`: the repo's spike notes (`docs/spikes/*.md`), published by `scripts/publish-notes.mjs` before every `dev`, `build` and `test`. The generated pages are gitignored, so edit the notes in `docs/spikes/`, not here. The decision records in `docs/adr/` stay in the repo; `docs/decisions.mdx` summarizes them and links to GitHub.
- `public/`: the Patronage mark (`logo.svg` in the header, `icon.svg` as the favicon) and any other static files.
- `blume.config.ts`: title, theme tokens, footer and the GitHub link.
- `theme.css`: the standard Patronage Blume shell, shared with the other Patronage docs sites: light and dark tokens, a white header and its cyan-to-pink top edge.

`pnpm test` checks every internal link with `blume validate --strict`.

## Deploy

The Worker is configured in `cloudflare.config.ts` for the `cf` CLI (no Wrangler config). Blume builds with its own Astro setup rather than the Cloudflare Vite plugin, so `scripts/build-output.mjs` writes the Cloudflare Build Output from `dist/` with the libraries `cf` uses, and the deploy uploads it with `cf deploy --prebuilt`.

```sh
pnpm --filter docs-site run deploy             # production
pnpm --filter docs-site run deploy --preview   # a Worker Preview named after the branch
pnpm --filter docs-site run deploy --dry-run   # build and check, upload nothing
pnpm --filter docs-site run builds:configure   # point Workers Builds at this app
```

`WORKER_DOMAIN` sets the custom domain and, in `blume.config.ts`, the site URL for the sitemap, canonical links and Open Graph cards. `WORKER_DOMAIN_PREVIEWS=true` also serves Previews on that domain. The site has no secrets or bindings.
