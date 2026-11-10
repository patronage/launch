# Changesets

A pull request that changes a published package (`@patronage/access`, `@patronage/mcp-core`, `@patronage/mcp-payload` or `@patronage/mcp-wordpress`) adds a changeset here: run `pnpm changeset`, pick the packages and the bump, and write one or two sentences for the changelog. `pnpm verify` runs `pnpm release:check`, which fails when a published package's `src/` or `package.json` changed since `origin/main` and the branch has no changeset.

The release steps are in [Releasing the npm packages](../apps/docs-site/docs/references/mcp.mdx#releasing-the-npm-packages).
