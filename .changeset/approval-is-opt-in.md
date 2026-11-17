---
"@patronage/mcp-core": minor
---

**Breaking:** writes are no longer held for approval unless the deployment asks. `execute` now applies each write as soon as the model's code calls `apply`, as the signed-in person, and returns the script's result with a receipt for each write in `receipts`. Set `APPROVAL_REQUIRED` to `"true"` to keep the approval card and page; a site that relies on approval must set it before upgrading. Any value other than unset, empty or `"false"` asks for approval.

Without approval, `execute` is annotated as a tool that writes, its description tells the model there is no approval step, no card, card tools or approval link are offered, a write that cannot be previewed is rejected, and one run may make at most 10 writes. The wide event records these writes with `approval.outcome: "not_required"`. `APPROVAL_CSRF_SECRET` is needed only where approval is required.
