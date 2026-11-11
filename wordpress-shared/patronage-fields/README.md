# Patronage Fields

The ACF field groups, post types and demo seed that both WordPress installs share, so [`apps/cms-wordpress-headless`](../../apps/cms-wordpress-headless) and [`apps/cms-wordpress-timber`](../../apps/cms-wordpress-timber) edit the same content ([ADR 0015](../../docs/adr/0015-shared-wordpress-fields.md)).

| Path | What it is |
| --- | --- |
| `patronage-fields.php` | The loader: Composer's autoloader, `post-types.php`, and every file in `fields/` on `acf/init`. ACF's JSON sync is off. |
| `fields/` | Field groups written with [Extended ACF](https://github.com/vinkla/extended-acf): the Hero and the Page Builder. Layout and field names follow [`packages/content-model`](../../packages/content-model). |
| `post-types.php` | Post types and admin list columns, with [Extended CPTs](https://github.com/johnbillion/extended-cpts). |
| `field-values.php` | Keeps stored field values behind the field editor: see [Stored values](#stored-values). |
| `seed/seed.php` | Invented demo content (the Neighborhood Growers pages the Payload app seeds too), run by each install's `bin/seed.sh`. |

## How an install loads it

WordPress loads only top-level mu-plugin files, so each install commits `wp-content/mu-plugins/patronage-fields.php`, which requires `patronage-fields/patronage-fields.php` beside it. Locally, Docker bind-mounts this folder there; for deploys, the install's `bin/build.sh` copies it in (minus the seed). Both installs need Secure Custom Fields active and Extended ACF and Extended CPTs in their `composer.json`.

The WPGraphQL settings in the field groups (`show_in_graphql`, `graphql_field_name`) do nothing where WPGraphQL is not installed, as on the Timber install.

## Stored values

ACF stores each field as post meta under the field's name (`body`, `sections_0_heading`). `field-values.php` marks those names as protected meta, so they can be written only through the field editor and `update_field()`, not through WordPress's Custom Fields box or XML-RPC, and it stops `get_field()` returning a value that has no field behind it. Scripts that write field values use `update_field()`, as the seed does; a value written with `update_post_meta()` alone is not returned.

Rich-text fields are filtered with `wp_kses_post()` each time they are loaded, before shortcodes run, so a rich-text value cannot carry script or an iframe whoever saved it. Embeds, buttons, images and pullquotes go in as the shortcodes in `rich-text-blocks.php`.

## Changing fields

Edit the PHP here, never in wp-admin. Keep the field group `key`s as they are: ACF derives the stored field keys from them, so a new key orphans existing content. After a change, regenerate the headless front-end's types (`pnpm --filter web-wordpress codegen:schema`, then `pnpm --filter @launch/adapter-wordpress codegen`) and update the Timber theme's `inc/content.php` and views.
