# @patronage/wpgraphql

The WordPress side of a headless front-end on Workers, with no framework code: it works under the App Router, the Pages Router or a plain Worker. [`apps/web-wordpress`](../../apps/web-wordpress) is the reference that uses it.

| Export | Use |
| --- | --- |
| `createWordPressFetch(config)` | One fetch for every WordPress request (GraphQL and original media). Sends the Cloudflare Access service token when one is configured (none for local Docker; half a token fails closed), refuses other origins, doesn't follow redirects, and throws when Access refuses. For previews, pass the editor's Access JWT as the third argument: it is verified and forwarded with a gateway proof, the `patronage-access` mu-plugin's contract. Each request counts toward `upstream.wordpress` on the wide event from `@patronage/logging`. |
| `readGraphQLData(response)` | A WPGraphQL response's `data`, or a `WordPressQueryError` (`code` `http`, `graphql` or `empty`, with `status` for HTTP) so a caller that caches reads never caches a failure. |
| `persistedQueryId(document)`, `persistedQueryBody(id, variablesJson)` | Send a GraphQL Code Generator document (client preset with `persistedDocuments`) by its SHA-256, for WPGraphQL Smart Cache's registered queries. |
| `smartCacheTags(header)`, `pathTag(path)`, `WORDPRESS_CACHE_TAG` | Cache tags from a response's `X-GraphQL-Keys` (node, `list:` and `skipped:` keys only) and for a front-end path, matching what the `patronage-headless-revalidate` mu-plugin sends. |

## Example

```ts
import {
  createWordPressFetch,
  persistedQueryBody,
  persistedQueryId,
  readGraphQLData,
  smartCacheTags,
} from "@patronage/wpgraphql";

const wordpressFetch = createWordPressFetch({
  origin: process.env.WORDPRESS_URL!,
  accessClientId: process.env.WORDPRESS_ACCESS_CLIENT_ID,
  accessClientSecret: process.env.WORDPRESS_ACCESS_CLIENT_SECRET,
});

const response = await wordpressFetch(`${process.env.WORDPRESS_URL}/graphql`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: persistedQueryBody(
    persistedQueryId(PageQuery),
    JSON.stringify({ uri })
  ),
});
const data = await readGraphQLData<PageQueryResult>(response);
const tags = smartCacheTags(response.headers.get("x-graphql-keys"));
```

Under the App Router, wrap the read in `"use cache"` and pass `tags` to `cacheTag`. Under the Pages Router, wrap it in `unstable_cache` with the same tags. Run vinext's cache on KV (`kvDataAdapter`) so a revalidation reaches every isolate.

Needs `nodejs_compat` on Workers, for the request timing's `AsyncLocalStorage`.
