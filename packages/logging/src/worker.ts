import type { LoggerConfig, RedactConfig } from "evlog";
import { initWorkersLogger, withEvlog } from "evlog/workers";
import type { WorkerExecutionContext } from "evlog/workers";

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
    (request, env, ctx) => entry.fetch(request, env, ctx),
    {
      exclude: options.exclude ?? DEFAULT_EXCLUDE,
      redact: LAUNCH_REDACTION,
    }
  );

  // Keep the entry's other handlers, such as scheduled or queue.
  return { ...entry, fetch: wrapped.fetch };
};
