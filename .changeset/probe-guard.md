---
"@patronage/launch-logging": minor
---

Add `withProbeGuard` and `isProbePath`: a Worker-entry guard that answers scanner paths such as `/.env`, `/wp-login.php`, `/xmlrpc.php` and `/cgi-bin/` with an empty 404 before the app runs. Put it inside `withRequestLog`, which marks a guarded request's event `probe: true`. Sites pass `allow` and `extra` to adjust the shared list. Also exported from `@patronage/launch-logging/probe`, which has no dependencies.
