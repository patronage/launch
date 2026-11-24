// What withRequestLog collects for one request's wide event while it runs.
import { AsyncLocalStorage } from "node:async_hooks";

import type { DataCacheCounts } from "./data-cache.ts";
import type { UpstreamTiming } from "./upstream.ts";

export interface RequestStore {
  /** `upstream.<name>` totals: see timeUpstream. */
  upstream: Map<string, UpstreamTiming>;
  /** `dataCache` totals: see withDataCacheLog. Set on the first read or write. */
  dataCache?: DataCacheCounts;
  /**
   * True until the wide event is emitted. Work that finishes later, such as a
   * background refresh or a cache write in waitUntil, logs its own line.
   */
  open: boolean;
  /** The wide event's `requestId`, so those lines can be joined to it. */
  requestId: string | undefined;
}

export const requestStore = new AsyncLocalStorage<RequestStore>();
