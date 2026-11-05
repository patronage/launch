# @patronage/mcp-wordpress

The WordPress connector for [`@patronage/mcp-core`](../mcp-core). In the gateway's sandbox it is `wp`:

- `wp.graphql({ query, variables? })` runs WPGraphQL queries, never mutations.
- `wp.get({ path, query? })` reads the REST API under `/wp-json/`, and refuses method overrides.
- `wp.apply({ intent, operations })` stages operations for approval:
  - `update_post` changes core fields, ACF fields and registered post meta (`meta`), with an optional `expected_modified_gmt` check.
  - `upsert_redirect` creates or updates one plain-URL rule in the Redirection plugin: `{ source: "/old-page", target: "/new-page", code?: 301 | 302 | 307 | 308 }`.

It also gives `describe_site` the site's post types and GraphQL types.

Requests go out as the signed-in person: the gateway forwards the Access JWT with a proof signed by `WORDPRESS_ACCESS_PROOF_SECRET`, which the `patronage-access` mu-plugin checks before it maps the JWT to a WordPress user. Bindings are in `WordPressEnv` (`src/env.ts`); the connector is on when `WORDPRESS_API_URL` is set.

```ts
import { wordpressConnector } from "@patronage/mcp-wordpress";
```

## Post meta

WordPress only accepts meta keys a site registers for REST, so the site decides what is writable. A key that isn't registered is dropped, and the receipt reports it as not stored. For example, to let editors change Yoast's meta description and noindex setting on pages:

```php
foreach ( [ '_yoast_wpseo_metadesc', '_yoast_wpseo_meta-robots-noindex' ] as $key ) {
	register_post_meta( 'page', $key, [
		'single'        => true,
		'type'          => 'string',
		'show_in_rest'  => true,
		'auth_callback' => fn ( $allowed, $meta_key, $post_id ) => current_user_can( 'edit_post', $post_id ),
	] );
}
```

## Redirects

`upsert_redirect` uses Redirection's REST API (`/wp-json/redirection/v1/`). It owns the one rule with the same source, a plain URL match and no regex. It updates that rule in place, keeping its group and title, or creates one in the first enabled WordPress group. The preview shows the current target and code against the new ones, and apply refuses to write if that rule changed after the preview. A disabled rule, or two rules for the same source, stop the operation for an editor to sort out in Redirection. The approver needs Redirection's capability: `manage_options`, unless the site filters `redirection_role`.
