// vinext's KV data cache (kvDataAdapter), wrapped so each request's wide event
// counts its data cache hits, stale reads and misses, and a KV read or write
// that fails logs a warning. vinext itself treats a failed read as a miss and
// drops a failed write, so a broken store would otherwise show only as slower
// pages and more reads sent to WordPress. vite.config.ts points `cache.data`
// at this module in place of the adapter's own runtime.
import { withDataCacheLog } from "@patronage/launch-logging";
import createKvDataCacheAdapter from "@vinext/cloudflare/cache/kv-data-adapter.runtime";

const createDataCacheAdapter = (
  input: Parameters<typeof createKvDataCacheAdapter>[0]
): ReturnType<typeof createKvDataCacheAdapter> =>
  withDataCacheLog(createKvDataCacheAdapter(input));

export default createDataCacheAdapter;
