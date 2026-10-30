# Architecture decision records

One file per decision that the rest of the repo must follow, numbered in order: `NNNN-short-title.md` with Status, Context, Decision and Consequences sections. Spike notes in [`../spikes/`](../spikes/) hold the evidence; a record here holds the rule.

To change a decision, add a new record that supersedes the old one and set the old one's status to `Superseded by ADR NNNN`. Don't edit an accepted decision in place beyond small corrections.

## Catalog

| Record | Decision an agent should follow |
| --- | --- |
| [0001](0001-public-reference-monorepo.md) | One public monorepo: no vendor code, no client references |
| [0002](0002-plain-pnpm-workspaces.md) | Plain pnpm workspaces, exact pins, `minimumReleaseAge` 3h now and 72h as the goal |
| [0003](0003-cloudflare-config-through-cf-cli.md) | No Wrangler files; `cloudflare.config.ts` plus cf CLI and API scripts |
| [0004](0004-local-verification-and-workers-builds.md) | No GitHub Actions; `pnpm verify` locally, deploys and previews on Workers Builds |
| [0005](0005-vinext-front-ends-on-workers.md) | vinext 1.4.x Front-ends on Workers with KV caching; WPGraphQL, no REST Front-end |
| [0006](0006-separate-wordpress-installs.md) | Separate headless and Timber WordPress installs |
| [0007](0007-payload-single-app-on-d1.md) | Payload 4 as one app on the Local API, D1 by default, Postgres via Hyperdrive as an option |
| [0008](0008-cms-neutral-content-model.md) | CMS-neutral Content model, one Adapter per CMS, rich text stays CMS-specific |
| [0009](0009-shadcn-ui-package.md) | `packages/ui` on shadcn/ui and Tailwind 4 with Section, Container and Typography |
| [0010](0010-wordpress-fields-in-php.md) | WordPress fields with vinkla/extended-acf on Secure Custom Fields, post types with extended-cpts |
| [0011](0011-cms-behind-cloudflare-access.md) | Every CMS behind Cloudflare Access; read-only Service tokens |
| [0012](0012-one-mcp-worker.md) | One MCP Worker with a backend package per CMS |
| [0013](0013-wordpress-deploy-kit.md) | The WordPress deploy kit lives in `wordpress-shared/wp-deploy` |
