# ADR 0015: WordPress fields are shared by both installs

## Status

Accepted, 2026-10-30. Supersedes the "theme's `fields/` folder" location in ADR 0010; the rest of 0010 stands.

## Context

ADR 0006 keeps the headless and Timber WordPress installs separate. Both edit the same pages, heroes and sections, and their field names must follow the Content model. Two copies of the field groups would drift.

## Decision

- The field groups, post types and demo seed live in `wordpress-shared/patronage-fields`, not in either theme.
- Each install loads them as an mu-plugin: a committed one-line loader in `wp-content/mu-plugins/`, with the folder bind-mounted by Docker locally and copied in by the install's `bin/build.sh` for deploys.
- The field groups keep their WPGraphQL settings, which are inert on the Timber install.
- The Timber theme maps field values to the Content model's shapes in PHP and renders them with Twig views that mirror `packages/ui`, sharing its Tailwind theme (`@launch/ui/theme.css`) and tokens but no components.

## Consequences

- A field change is made once and shows up in both installs; the headless Adapter's types and the Timber views both need updating with it.
- Field group keys stay fixed (ACF derives stored field keys from them), even though the old ones name the headless theme.
- Both installs need Secure Custom Fields, Extended ACF and Extended CPTs.
