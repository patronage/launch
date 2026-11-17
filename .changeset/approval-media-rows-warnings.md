---
"@patronage/mcp-core": minor
---

Approval previews can show a thumbnail beside a media change (`beforeImage` and `afterImage` on a field snapshot), a readable label for a row path, and a warning on an operation that changes what the public sees at once. Receipts can carry `version_id`, `updated_at` and bounded `details`. The runtime store can stage a file for a later `apply` (`stageBlob`, `readBlob`, `readBlobMeta`), and a connector's `preflight` receives the run's id and store. The approval page's Content-Security-Policy now allows `data:` images, and the approval card moves to `ui://patronage/cms-approval-v5.html`; the earlier URIs keep working.
