---
"@patronage/launch-logging": minor
---

`withDataCacheLog(handler)` wraps a framework data cache handler, such as vinext's KV `kvDataAdapter`, so each request's wide event gets `dataCache` totals (`hits`, `stale`, `misses`, `readErrors`, `writeErrors`) and a read or write that fails logs a `data_cache.error` warning instead of passing silently. An upstream call that fails after the request's event was emitted, such as a stale entry's background refresh, now logs its own `upstream.failed` line with `afterResponse: true` and the event's `requestId`.
