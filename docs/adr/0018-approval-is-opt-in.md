# ADR 0018: Writes apply by default, and Approval is opt-in per site

## Status

Proposed, 2026-11-11. Replaces the "No unapproved writes" decision in [ADR 0014](0014-mcp-gateway-worker.md); the rest of that record stands.

## Context

ADR 0014 held every CMS write for a person to approve. In use, that pause is rarely what a site's team wants. The person asked for the change in the conversation, they are signed in as themselves, and the CMS already limits what they may edit and keeps drafts and revisions. For them the card and the approval page are a second confirmation of something they just asked for.

Some sites do need the pause. Their content is sensitive, more people use the server, or their own process says a person must see a change before it lands. For those sites Approval is a requirement, not a convenience.

## Decision

- **The MCP gateway is write-permissive by default.** A write is applied as soon as the model's code calls `apply`, as the signed-in person. A deployment that sets nothing gets this.
- **A site that needs Approval asks for it.** `APPROVAL_REQUIRED=true` at build time makes the deployment hold every write for a person to accept, on the inline card or the browser approval page, as ADR 0014 described. It covers the whole deployment: there is no switch per person, per tool or per request.
- **A mistyped setting asks for Approval.** Only unset, empty and `false` mean "not required". Any other value holds writes, so a typo never drops the Approval a site asked for.
- **Every write takes the same path.** With or without Approval, the gateway builds and stores the same preview, refuses a write it cannot preview, applies exactly that preview, and records a receipt. Without Approval, only the person looking at it is missing. The CMS's own permissions still decide what the signed-in person may change.
- **Nothing is left waiting where nobody is asked.** Without Approval the gateway offers no card, no card tools and no approval link, rejects a write it cannot preview, and stops a run at 10 writes.
- **The server says which it is.** `execute` is annotated as a tool that writes unless Approval is required, its description tells the model whether a write is held, and the wide event records `approval.outcome` as `not_required` or as the person's decision.

## Consequences

- By default, a prompt injection in content the model reads can change the CMS with no person seeing the change first. Drafts, revisions and the person's own CMS role are what limit a bad write. A site where that is not enough sets `APPROVAL_REQUIRED`.
- An existing deployment that upgrades and sets nothing stops holding writes. The release that carries this is a breaking one, and a site that relied on Approval must set `APPROVAL_REQUIRED=true` before it upgrades.
- An MCP client may ask the person to confirm each `execute` call, because by default the tool no longer reads as read-only. That prompt is the client's own and shows the code, not a before-and-after.
- Only a deployment that requires Approval needs `APPROVAL_CSRF_SECRET`.
- "A person approved every write" is true only of deployments that require Approval. A log reader tells the two apart by `approval.outcome`.
