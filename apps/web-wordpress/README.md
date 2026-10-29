# web-wordpress

A [vinext](https://github.com/cloudflare/vinext) (App Router) front-end for the headless WordPress in [`apps/cms-wordpress-headless`](../cms-wordpress-headless), reading content over WPGraphQL.

```sh
pnpm --filter cms-wordpress-headless setup   # once: WordPress, demo content and .env.local
pnpm --filter web-wordpress dev              # http://localhost:3000, in local workerd
pnpm --filter web-wordpress build && pnpm --filter web-wordpress start   # the built Worker (vite preview)
```

It deploys as the Cloudflare Worker `launch-vinext-wordpress`, configured in `cloudflare.config.ts` for the `cf` CLI (no Wrangler config), with the Spike 1 setup from `apps/spike-vinext`: ISR pages and fetch data in the `VINEXT_KV_CACHE` KV namespace, so a revalidation reaches every isolate, and the Images binding for `next/image`.

```sh
pnpm --filter web-wordpress run deploy             # vite build, then cf deploy --prebuilt
pnpm --filter web-wordpress run deploy --preview   # a Worker Preview named after the branch
pnpm --filter web-wordpress run secrets            # HEADLESS_SECRET, WORDPRESS_PREVIEW_USER, WORDPRESS_PREVIEW_PASSWORD from the environment
pnpm --filter web-wordpress run builds:configure   # point Workers Builds at this app
```

`WORDPRESS_URL` is a plain-text binding, taken from the environment when the Worker is built.

## Layout

- `app/[[...slug]]/page.tsx`: every published page and post, looked up by URI. Cached (ISR) until WordPress revalidates it, with an hourly fallback.
- `app/preview/[id]/page.tsx`: drafts and unsaved changes, only in draft mode.
- `app/api/revalidate`, `app/api/preview`, `app/api/exit-preview`: the routes WordPress calls or links to.
- `lib/wordpress/`: the GraphQL client, queries and preview-token check.
- `components/content-view.tsx`: renders WordPress data as it arrives, until Spike 2's adapter and `packages/ui` replace it.

## GraphQL types and registered queries

Queries are written with `graphql()` from `@/gql` and typed by GraphQL Code Generator against `schema.graphql`, a committed snapshot of the WPGraphQL schema, so `pnpm typecheck` and `pnpm build` need no running WordPress. `gql/` is generated and gitignored.

WordPress runs only registered queries (WPGraphQL Smart Cache persisted queries), so requests send the query's SHA-256 ID, never its text. After adding or changing a query, write the manifest WordPress registers and commit it with the change (`pnpm test` fails while it is stale):

```sh
pnpm --filter web-wordpress documents
```

After changing plugins or ACF fields, refresh the schema snapshot from the local WordPress with WP-CLI, which, unlike HTTP introspection, keeps deprecated arguments:

```sh
pnpm --filter web-wordpress codegen:schema
```

## Environment

See `.env.example`. `HEADLESS_SECRET` must match WordPress's. The preview user's application password is only sent on preview requests, which are never cached.
