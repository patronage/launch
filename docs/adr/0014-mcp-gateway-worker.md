# ADR 0014: One MCP gateway Worker per site, published as packages

## Status

Accepted, 2026-10-31. Supersedes [ADR 0012](0012-one-mcp-worker.md). Corrected 2026-11-09 to name the contract tests.

## Context

The goal is one MCP server that a site's team installs once, signs in to securely, and that Patronage can add tools to over time.

Patronage already runs this pattern outside Launch: an Access-fronted Worker that runs model-written JavaScript against a WordPress connector in a Dynamic Worker ("code mode"), pauses every write for a person to approve a before-and-after, logs one wide event per request, and ships as an Agent Plugin package for Claude, Codex and Cursor. Each site that used it copied the template, and the copies drifted.

Since ADR 0012, both CMSs ship their own MCP servers:

- Payload's `@payloadcms/plugin-mcp` (at our pinned `4.0.0-beta.6`) adds a stateless, JSON-only `POST /api/mcp` to the Payload app. It signs callers in through `payload.auth()`, so `accessAuthStrategy` from `@patronage/access` fits, and runs its tools through the Local API as that user.
- WordPress has the Abilities API in core (6.9 and later) and the official MCP Adapter plugin, which exposes abilities as MCP tools.

Payload's Local API exists only inside the Payload Worker, so a separate MCP Worker cannot run Payload's tools in process.

## Decision

- **The gateway Worker is the product.** `apps/mcp` is the one MCP endpoint a site's team installs. It owns sign-in, the tool catalog, write approval and logging. Each CMS sits behind it as a backend.
- **Cloudflare Access is the only sign-in Launch ships.** It keeps [ADR 0011](0011-cms-behind-cloudflare-access.md) as written. A [docs-site page](../../apps/docs-site/docs/references/mcp-workos.mdx) records what a site would need to sign in with WorkOS AuthKit instead.
- **Code mode for content, typed tools for workflows.** The model gets `execute`, which runs JavaScript against one connector per backend (`wp`, `payload`), plus `describe_site`. Named workflows that are not CMS content come as typed tools in tool packs.
- **No unapproved writes.** Every CMS write pauses for a person to approve, through the inline MCP Apps card or the browser approval page, and runs as the approver. The `payload` connector reaches Payload's `/api/mcp` over a Service binding, and its writes pause and replay the same way `wp.apply` does. Payload's delete and auth tools are turned off. Changes to code go through a pull request instead.
- **Published, not copied.** The Worker and its parts move from the template repository into this monorepo (`apps/mcp`, `packages/mcp-core` and one package per backend) and are published to npm under `@patronage`. A site's own repository depends on those packages and holds only its configuration and its own tool packs.
- **Usage reporting is future work.** Workers Logs keep the wide events for seven days, which is enough to debug. A weekly usage report would need the events kept longer, most likely through Logpush to R2. It is not built yet.

## Consequences

- `packages/mcp-payload` is a connector that calls Payload's own MCP endpoint, not a re-implementation of Payload's tools over REST.
- Code mode needs Dynamic Workers, which are in open beta and need a paid Workers plan.
- We depend on pre-1.0 pieces: Dynamic Workers, `@cloudflare/codemode`, the Payload 4 beta and its MCP plugin, and the WordPress MCP Adapter. Contract tests are how we notice when an upgrade breaks a connector: `packages/mcp-core/src/codemode.contract.test.ts` covers the `@cloudflare/codemode` surface mcp-core relies on, and the connector tests in `packages/mcp-payload` and `packages/mcp-wordpress` cover what each connector expects from Payload's MCP plugin and the WordPress MCP Adapter. Run them after upgrading any of those pieces.
- The template used a Wrangler config. In this monorepo the Worker follows [ADR 0003](0003-cloudflare-config-through-cf-cli.md): `cloudflare.config.ts` and the cf CLI.
- Publishing to npm adds versioning and a release step. Packages must stay free of site-specific names, hosts and tools ([ADR 0001](0001-public-reference-monorepo.md)).
- The first build step is a spike that runs Payload's MCP plugin under vinext on Workers with D1.
