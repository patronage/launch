// Visibility for a framework data cache (vinext's `"use cache"` and fetch
// cache), whose own failures are otherwise swallowed: a read that fails is
// treated as a miss and a write that fails is dropped, so a broken store shows
// only as slower pages and more reads sent to the CMS.
import { log } from "evlog";
import { z } from "zod";

import { requestStore } from "./request-store.ts";

/** A request's data cache reads and writes, as `dataCache` on its wide event. */
export interface DataCacheCounts {
  hits: number;
  /** Served stale while the framework refreshes it in the background. */
  stale: number;
  misses: number;
  readErrors: number;
  writeErrors: number;
}

type Operation = "read" | "write";

/** Only data entries count; a rendered page is the event's `cache` field. */
const dataEntry = z.object({ kind: z.literal("FETCH") });

/** What a handler's get() answers: null on a miss. */
const storedEntry = z.object({
  cacheState: z.string().optional(),
  value: z.object({}).loose(),
});

const count = (field: keyof DataCacheCounts): void => {
  const store = requestStore.getStore();

  if (!store?.open) {
    return;
  }

  store.dataCache ??= {
    hits: 0,
    misses: 0,
    readErrors: 0,
    stale: 0,
    writeErrors: 0,
  };
  store.dataCache[field] += 1;
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-get, anti-slop/no-reflect-apply, anti-slop/no-runtime-typeof -- withDataCacheLog is a transparent Proxy over a framework's cache handler: it forwards whatever the handler takes and returns without knowing its types, and only reads the entry kind and cache state it needs. */

/**
 * A failed read or write is a warning: the page still renders. It carries the
 * error's name only, since a store's message can quote the cache key.
 */
const warn = (operation: Operation, error: unknown): void => {
  count(operation === "read" ? "readErrors" : "writeErrors");
  log.warn({
    cacheError: operation,
    errorName: error instanceof Error ? error.name : "unknown",
    event: "data_cache.error",
    requestId: requestStore.getStore()?.requestId,
  });
};

/** Hit, stale or miss, as the store answered (an expired entry is a miss). */
const outcome = (answer: unknown): keyof DataCacheCounts => {
  const entry = storedEntry.safeParse(answer);

  if (!entry.success || entry.data.cacheState === "expired") {
    return "misses";
  }

  return entry.data.cacheState === "stale" ? "stale" : "hits";
};

const isDataEntry = (value: unknown): boolean =>
  dataEntry.safeParse(value).success;

/**
 * Wrap a data cache handler (such as the one `@vinext/cloudflare`'s
 * `kvDataAdapter` creates) so each data read counts toward `dataCache` on the
 * request's wide event, and a read or write that fails logs a
 * `data_cache.error` warning. Failures are rethrown, so the framework handles
 * them exactly as before. Every other method passes through unchanged.
 */
export const withDataCacheLog = <Handler extends object>(
  handler: Handler
): Handler =>
  new Proxy(handler, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);

      if (typeof value !== "function") {
        return value;
      }

      if (property === "get") {
        return async (...args: unknown[]) => {
          if (!isDataEntry(args[1])) {
            return Reflect.apply(value, target, args);
          }

          try {
            const entry: unknown = await Reflect.apply(value, target, args);

            count(outcome(entry));

            return entry;
          } catch (error) {
            warn("read", error);
            throw error;
          }
        };
      }

      if (property === "set") {
        return async (...args: unknown[]) => {
          if (!isDataEntry(args[1])) {
            return Reflect.apply(value, target, args);
          }

          try {
            return await Reflect.apply(value, target, args);
          } catch (error) {
            warn("write", error);
            throw error;
          }
        };
      }

      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  });
