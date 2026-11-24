# @patronage/launch-logging

## 0.3.0

### Minor Changes

- 1aaa0e3: `withDataCacheLog(handler)` wraps a framework data cache handler, such as vinext's KV `kvDataAdapter`, so each request's wide event gets `dataCache` totals (`hits`, `stale`, `misses`, `readErrors`, `writeErrors`) and a read or write that fails logs a `data_cache.error` warning instead of passing silently. An upstream call that fails after the request's event was emitted, such as a stale entry's background refresh, now logs its own `upstream.failed` line with `afterResponse: true` and the event's `requestId`.

## 0.2.0

### Minor Changes

- d520291: Add `withProbeGuard` and `isProbePath`: a Worker-entry guard that answers scanner paths such as `/.env`, `/wp-login.php`, `/xmlrpc.php` and `/cgi-bin/` with an empty 404 before the app runs. Put it inside `withRequestLog`, which marks a guarded request's event `probe: true`. Sites pass `allow` and `extra` to adjust the shared list. Also exported from `@patronage/launch-logging/probe`, which has no dependencies.

## 0.1.0

### Minor Changes

- b0bd828: First npm releases. `@patronage/launch-images` (formerly the private `@launch/images`) serves CMS images through the Cloudflare Images binding. `@patronage/launch-logging` publishes the Worker wide-event wrapper and the Cloudflare log-store helpers. `@patronage/launch-wpgraphql` is the framework-neutral WPGraphQL transport taken out of the headless WordPress front-end: Access service token and preview identity, persisted query IDs, Smart Cache tags, typed read errors and `upstream.wordpress` timing.
