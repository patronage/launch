# ADR 0012: One MCP Worker with a backend per CMS

## Status

Superseded by [ADR 0014](0014-mcp-gateway-worker.md).

## Context

Patronage's earlier MCP server spoke only to WordPress. Launch has two CMSs, and agents should get the same tools whichever one a site uses.

## Decision

- One MCP Worker in `apps/mcp`, fronted by Cloudflare Access.
- Shared tool definitions and transport in `packages/mcp-core`.
- One backend plugin per CMS: `packages/mcp-wordpress` and `packages/mcp-payload`.
- It adopts the `PATRONAGE_ACCESS_*` names from [ADR 0011](0011-cms-behind-cloudflare-access.md).

## Consequences

- A new CMS means a new backend package, not a new MCP server.
