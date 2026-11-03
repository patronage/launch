# @patronage/mcp-wordpress

The WordPress connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `wp`:

- `wp.graphql({ query, variables? })` runs WPGraphQL queries, never mutations.
- `wp.get({ path, query? })` reads the REST API under `/wp-json/`, and refuses method overrides.
- `wp.apply({ intent, operations })` stages `update_post` operations (core and ACF fields, with an optional `expected_modified_gmt` check) for approval.

It also gives `describe_site` the site's post types and GraphQL types.

Requests go out as the signed-in person: the gateway forwards the Access JWT with a proof signed by `WORDPRESS_ACCESS_PROOF_SECRET`, which the `patronage-access` mu-plugin checks before it maps the JWT to a WordPress user. Bindings are in `WordPressEnv` (`src/env.ts`); the connector is on when `WORDPRESS_API_URL` is set.

```ts
import { wordpressConnector } from "@patronage/mcp-wordpress";
```
