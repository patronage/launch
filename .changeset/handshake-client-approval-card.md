---
"@patronage/mcp-core": patch
---

Offer the approval card to clients that state MCP Apps support only in `initialize`. The gateway keeps no session, so it used to read every later request from such a client as stating nothing, and listed no card, no card resource and no card tools. It now answers `initialize` with an `Mcp-Session-Id` that carries what the client stated, and reads it back on the requests that follow. The per-request capabilities envelope still decides when a request has one.
