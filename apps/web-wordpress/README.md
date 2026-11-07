# web-wordpress

A [vinext](https://github.com/cloudflare/vinext) (App Router) front-end for the headless WordPress in [`apps/cms-wordpress-headless`](../cms-wordpress-headless), reading content over WPGraphQL.

```sh
pnpm --filter cms-wordpress-headless run setup   # once: WordPress, demo content and .env.local
pnpm --filter web-wordpress dev              # http://localhost:3000, in local workerd
pnpm --filter web-wordpress build && pnpm --filter web-wordpress start   # the built Worker (vite preview)
```

It deploys as the Cloudflare Worker `launch-vinext-wordpress`, configured in `cloudflare.config.ts` for the `cf` CLI (no Wrangler config), with the setup from Spike 1 ([`docs/spikes/02-vinext-on-workers.md`](../../docs/spikes/02-vinext-on-workers.md)): ISR pages and fetch data in the `VINEXT_KV_CACHE` KV namespace, so a revalidation reaches every isolate, and the Images binding, which resizes WordPress uploads at `/media`.

```sh
pnpm --filter web-wordpress run deploy             # vite build, then cf deploy --prebuilt
pnpm --filter web-wordpress run deploy --preview   # a Worker Preview named after the branch
pnpm --filter web-wordpress run secrets            # HEADLESS_SECRET, WORDPRESS_PREVIEW_USER, WORDPRESS_PREVIEW_PASSWORD from the environment
pnpm --filter web-wordpress run builds:configure   # point Workers Builds at this app
```

`WORDPRESS_URL` is a plain-text binding, taken from the environment when the Worker is built.

## Layout

- `app/[[...slug]]/page.tsx`: every published page and post, looked up by URI. Cached (ISR) until WordPress revalidates it, with an hourly fallback. Public reads are `"use cache"` entries tagged with WPGraphQL Smart Cache keys (`lib/wordpress/client.ts`, `cache-tags.ts`), so an edit expires only the pages that used the changed post; GraphQL errors are never cached. See [Cache tags](../cms-wordpress-headless/README.md#cache-tags).
- `app/preview/[id]/page.tsx`: drafts and unsaved changes, only in draft mode.
- `app/api/revalidate`, `app/api/preview`, `app/api/exit-preview`: the routes WordPress calls or links to.
- `app/forms/submit`: where form sections post `{ formId, values }`. It caps the body size, checks the shape and passes the values to the theme's Formidable route with the shared secret; WordPress checks each value against its field and saves the entry (see [Forms](../cms-wordpress-headless/README.md#forms)).
- `lib/wordpress/`: the GraphQL client, queries and preview-token check.
- `app/media/[...path]`: WordPress uploads, resized by the Cloudflare Images binding (`@launch/images`). vinext's `/_next/image` only resizes files in `public/` on Workers, so the adapter's `imageUrl` points every upload here instead.
- `lib/wordpress/sections.ts` and `components/content-view.tsx`: a page or post's hero and a page's Page Builder sections go through `@launch/adapter-wordpress` to `PageSections` from `@launch/ui`, with rich-text blocks drawn by its `RichTextBlock`. Without a hero, the title heads the page; block editor HTML follows when there are no sections.

## GraphQL types and registered queries

The page query spreads `PageHeroFields` and `PageBuilderFields`, the fragments in `packages/adapter-wordpress/src/page-builder.graphql` that the adapter is typed against, so codegen also reads that file. Queries are written with `graphql()` from `@/gql` and typed by GraphQL Code Generator against `schema.graphql`, a committed snapshot of the WPGraphQL schema, so `pnpm typecheck` and `pnpm build` need no running WordPress. `gql/` is generated and gitignored.

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

## CMS Access

Production GraphQL and original-media requests use the same Cloudflare Access service token. Configure `WORDPRESS_ACCESS_CLIENT_ID`, `WORDPRESS_ACCESS_CLIENT_SECRET` and `WORDPRESS_ACCESS_PROOF_SECRET` as Worker runtime secrets. Set the public build variables `ACCESS_TEAM_DOMAIN` and `ACCESS_PREVIEW_AUD` for the preview Access application. Local WordPress can run without the service token.

Protect `/api/preview` and `/preview` on each active frontend hostname. Preview reads verify the editor's Access assertion, forward it with a gateway proof, and retain the WordPress application password and `no-store` behavior. The proof secret must match `PATRONAGE_ACCESS_PROOF_SECRET` in WordPress.

Deploy the frontend and test its CMS reads before enabling the WordPress origin guard. Then configure the CMS Access application, the origin AUD, and the CLI cron described in [Access lockdown](../../docs/spikes/05-access-lockdown.md). Confirm public reads, editor previews, original media and origin denials after lockdown.

`pnpm run secrets` and production deploys upload values through stdin and suppress responses when values are supplied. `pnpm run secrets --preview-base` updates the separate Preview base secrets through the API, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; existing previews need their secrets updated separately. A Preview runs branch code, so give it its own Access service token and WordPress preview user rather than production's, so either can be revoked on its own. Dry runs never pass secret values to `cf`.
