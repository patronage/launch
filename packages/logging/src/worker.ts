import type { LoggerConfig, RedactConfig } from "evlog";
import { initWorkersLogger, withEvlog } from "evlog/workers";
import type { WorkerExecutionContext } from "evlog/workers";

import { upstreamFields, upstreamTimings } from "./upstream.ts";
import type { UpstreamTiming } from "./upstream.ts";

export { timedD1, timeUpstream } from "./upstream.ts";

export type { UpstreamTiming } from "./upstream.ts";

/**
 * Fields that never belong in a wide event, on top of evlog's built-in
 * patterns (emails, card numbers, IPv4, phone numbers, JWTs, bearer tokens).
 */
export const LAUNCH_REDACTION: RedactConfig = {
  paths: [
    "**.authorization",
    "**.body",
    "**.cookie",
    "**.headers",
    "**.password",
    "**.query",
    "**.secret",
    "**.token",
  ],
};

/** Paths that are never worth an event: build assets and browser probes. */
export const DEFAULT_EXCLUDE = [
  "/_next/static/**",
  "/*/_next/static/**",
  "/favicon.ico",
  "/robots.txt",
];

export interface RequestLogOptions {
  /** The `service` field on every event, such as `web-wordpress`. */
  service: string;
  /** Defaults to `production`. */
  environment?: string;
  version?: string;
  /**
   * Percentage (0 to 100) of healthy requests to keep. Errors (status 400 and
   * up) and slow requests are always kept. Defaults to 100.
   */
  sampleRate?: number;
  /** Requests at least this slow are always kept. Defaults to 1000 ms. */
  slowMs?: number;
  /** Route globs to skip entirely. Defaults to {@link DEFAULT_EXCLUDE}. */
  exclude?: string[];
}

/** The page cache result vinext reports: HIT, STALE or MISS. */
const cacheResult = (response: Response): string | undefined =>
  response.headers.get("x-vinext-cache") ??
  response.headers.get("x-nextjs-cache") ??
  undefined;

/** Anything with a Workers `fetch` handler, such as vinext's worker entry. */
export interface FetchEntry<TEnv> {
  fetch: (
    request: Request,
    env: TEnv,
    ctx: WorkerExecutionContext
  ) => Promise<Response> | Response;
}

const clampRate = (rate: number | undefined): number => {
  if (rate === undefined || Number.isNaN(rate)) {
    return 100;
  }

  return Math.min(100, Math.max(0, rate));
};

/**
 * Wrap a Worker's fetch entry so every request emits one evlog wide event as
 * a JSON console line. Nothing else is needed to collect it: Workers Logs keep
 * it for seven days, and Workers Trace Events Logpush (`logpush: true` on the
 * Worker) copies it to R2. With Logpush off, this costs one console line per
 * request and nothing more, so it is safe to leave on everywhere.
 */
export const withRequestLog = <TEnv, TEntry extends FetchEntry<TEnv>>(
  entry: TEntry,
  options: RequestLogOptions
): TEntry & FetchEntry<TEnv> => {
  const rate = clampRate(options.sampleRate);

  const environment: LoggerConfig["env"] = {
    environment: options.environment ?? "production",
    service: options.service,
  };

  if (options.version) {
    environment.version = options.version;
  }

  const config: LoggerConfig = { env: environment, redact: LAUNCH_REDACTION };

  if (rate < 100) {
    config.sampling = {
      keep: [{ status: 400 }, { duration: options.slowMs ?? 1000 }],
      rates: { info: rate },
    };
  }

  initWorkersLogger(config);

  const wrapped = withEvlog<TEnv>(
    (request, env, ctx, log) => {
      const timings = new Map<string, UpstreamTiming>();

      return upstreamTimings.run(timings, async () => {
        const response = await entry.fetch(request, env, ctx);
        const cache = cacheResult(response);

        if (cache) {
          log.set({ cache });
        }

        // evlog emits when the handler returns (it waits only for event
        // streams), so these totals cover the work before the response
        // starts, the same span as `duration`: a page's top-level awaited
        // reads, but not reads inside a Suspense boundary that streams later.
        // Traces cover those.
        if (timings.size > 0) {
          log.set({ upstream: upstreamFields(timings) });
        }

        return response;
      });
    },
    {
      exclude: options.exclude ?? DEFAULT_EXCLUDE,
      redact: LAUNCH_REDACTION,
    }
  );

  // Keep the entry's other handlers, such as scheduled or queue.
  return { ...entry, fetch: wrapped.fetch };
};
