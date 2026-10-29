# web-wordpress

A [vinext](https://github.com/cloudflare/vinext) (App Router) front-end for the headless WordPress in [`apps/cms-wordpress-headless`](../cms-wordpress-headless), reading content over WPGraphQL.

```sh
pnpm --filter cms-wordpress-headless setup   # once: WordPress, demo content and .env.local
pnpm --filter web-wordpress dev              # http://localhost:3000
pnpm --filter web-wordpress build && HOST=0.0.0.0 pnpm --filter web-wordpress start
```

## Layout

- `app/[[...slug]]/page.tsx`: every published page and post, looked up by URI. Cached (ISR) until WordPress revalidates it, with an hourly fallback.
- `app/preview/[id]/page.tsx`: drafts and unsaved changes, only in draft mode.
- `app/api/revalidate`, `app/api/preview`, `app/api/exit-preview`: the routes WordPress calls or links to.
- `lib/wordpress/`: the GraphQL client, queries and preview-token check.
- `components/content-view.tsx`: renders WordPress data as it arrives, until Spike 2's adapter and `packages/ui` replace it.

## GraphQL types

Queries are written with `graphql()` from `@/gql` and typed by GraphQL Code Generator against `schema.graphql`, a committed snapshot of the WPGraphQL schema, so `pnpm typecheck` and `pnpm build` need no running WordPress. `gql/` is generated and gitignored.

After changing plugins or ACF fields, refresh the snapshot from the local WordPress (WPGraphQL only allows introspection to signed-in users, so this uses the preview application password from `.env.local`):

```sh
pnpm --filter web-wordpress codegen:schema
```

## Environment

See `.env.example`. `HEADLESS_SECRET` must match WordPress's. The preview user's application password is only sent on preview requests, which are never cached.
