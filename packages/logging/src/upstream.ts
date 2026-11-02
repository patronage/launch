// Per-request upstream timing for the wide event. withRequestLog opens a
// store for each request; timeUpstream and timedD1 add to it.
import { AsyncLocalStorage } from "node:async_hooks";

/** Calls to one upstream during a request, as `upstream.<name>` on the event. */
export interface UpstreamTiming {
  calls: number;
  errors: number;
  /** Total wall time spent waiting on this upstream, in milliseconds. */
  ms: number;
}

export const upstreamTimings = new AsyncLocalStorage<
  Map<string, UpstreamTiming>
>();

/**
 * Time a call to an upstream, such as a WPGraphQL fetch or a D1 query, and add
 * it to the current request's wide event as `upstream.<name>`. Outside a
 * request that {@link withRequestLog} wraps, it just runs `work`.
 */
export const timeUpstream = async <Result>(
  name: string,
  work: () => Promise<Result>
): Promise<Result> => {
  const timings = upstreamTimings.getStore();

  if (!timings) {
    return work();
  }

  const started = performance.now();
  let failed = false;

  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const timing = timings.get(name) ?? { calls: 0, errors: 0, ms: 0 };

    timing.calls += 1;
    timing.errors += failed ? 1 : 0;
    timing.ms += performance.now() - started;
    timings.set(name, timing);
  }
};

export const upstreamFields = (
  timings: Map<string, UpstreamTiming>
): Record<string, UpstreamTiming> =>
  Object.fromEntries(
    [...timings].map(([name, timing]) => [
      name,
      { ...timing, ms: Math.round(timing.ms) },
    ])
  );

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply -- timedD1 is a transparent Proxy over a native binding: it forwards whatever D1 takes and returns without knowing its types. */

// D1's own methods brand-check their receiver and arguments, so each proxy
// calls through to the real object, and statements handed back to batch()
// are swapped for the real statements they wrap.
const unwrapped = new WeakMap<object, object>();

const unwrap = (value: unknown): unknown =>
  typeof value === "object" && value !== null
    ? (unwrapped.get(value) ?? value)
    : value;

// batch() takes an array of statements.
const unwrapArgument = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(unwrap) : unwrap(value);

type D1Kind = "database" | "statement";

const TIMED: Record<D1Kind, Set<string>> = {
  database: new Set(["batch", "exec"]),
  statement: new Set(["all", "first", "raw", "run"]),
};

// Methods that hand back another D1 object to wrap, and what kind it is.
const RETURNS = new Map<string, D1Kind>([
  ["bind", "statement"],
  ["prepare", "statement"],
  ["withSession", "database"],
]);

const wrapD1 = <Target extends object>(
  target: Target,
  kind: D1Kind,
  name: string
): Target => {
  const proxy = new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);

      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }

      const call = (args: unknown[]): unknown =>
        Reflect.apply(value, object, args.map(unwrapArgument));

      if (TIMED[kind].has(property)) {
        return (...args: unknown[]) =>
          timeUpstream(name, () => Promise.resolve(call(args)));
      }

      const returns = RETURNS.get(property);

      if (returns) {
        return (...args: unknown[]) => {
          const result = call(args);

          return typeof result === "object" && result !== null
            ? wrapD1(result, returns, name)
            : result;
        };
      }

      return (...args: unknown[]) => call(args);
    },
  });

  unwrapped.set(proxy, target);

  return proxy;
};

/**
 * Wrap a D1 binding so every query it runs counts toward `upstream.<name>`
 * (default `d1`) on the request's wide event. Queries run unchanged.
 */
export const timedD1 = <Database extends object>(
  database: Database,
  name = "d1"
): Database => wrapD1(database, "database", name);
