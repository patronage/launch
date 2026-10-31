import type { ApplyPreflight } from "./apply";

// The Durable Object is one long-lived object shared by every caller, so the
// forwarded Access JWT cannot live on it. It lives here instead: held for the
// duration of one call and dropped in a `finally`, never persisted and never
// logged. Calls are serialised through a tail promise so two callers are never
// in flight at once — an overlapping call waits rather than observing, or
// overwriting, the token of the call already running.
//
// HAZARD — re-entrancy deadlocks. Calling `run` from inside the `fn` of a
// running `run` queues the inner call behind a tail that only settles when the
// outer `fn` resolves, and the outer `fn` is waiting on the inner call: neither
// ever completes. There is no guard for it, because none can be written
// correctly here. The only state a guard could read synchronously is "a call is
// executing" — which is equally true of a second, legitimate RPC that arrived
// while the first was suspended at an `await`, the very case this queue exists
// to serve. Narrowing it to "the same caller token and nothing else queued"
// does not help: two concurrent requests from one signed-in person satisfy it
// too, so the guard would reject real work to prevent hypothetical work.
// Telling the two apart needs async context propagation (AsyncLocalStorage),
// which is a redesign of this module rather than a check inside it. Until then
// the rule is enforced by convention: `run` is called only from the Durable
// Object's own RPC entry points, and the connector tools reach the caller with
// `require()`, never by opening a scope of their own.
export interface CallerContext {
  // Set only on the replay a human approval runs under, where the codemode
  // runtime supplies no per-call execution id of its own.
  executionId?: string;
  // Also set only on that replay: the preview the approver answered, read
  // once before the resume so a preview rebuilt meanwhile cannot replace it.
  preflight?: ApplyPreflight;
  subjectOpaque: string;
  token: string;
}

export interface CallerScope {
  require: () => CallerContext;
  run: <T>(caller: CallerContext, fn: () => Promise<T>) => Promise<T>;
}

export class CallerScopeError extends Error {
  constructor() {
    super("No caller context is active for this WordPress request");
    this.name = "CallerScopeError";
  }
}

// The queue must survive a failed call: the tail settles either way, so a
// rejection frees the next caller instead of wedging the scope.
const settle = async <T>(call: Promise<T>): Promise<void> => {
  try {
    await call;
  } catch {
    // The rejection belongs to the caller that made it, not to the queue.
  }
};

export const createCallerScope = (): CallerScope => {
  let current: CallerContext | undefined;
  let tail: Promise<void> = Promise.resolve();

  const serve = async <T>(
    ahead: Promise<void>,
    caller: CallerContext,
    fn: () => Promise<T>
  ): Promise<T> => {
    await ahead;
    current = caller;

    try {
      return await fn();
    } finally {
      current = undefined;
    }
  };

  return {
    require: () => {
      if (!current) {
        throw new CallerScopeError();
      }

      return current;
    },
    // The slot is reserved synchronously, before the first await, so a second
    // `run` started in the same tick queues behind this one.
    run: (caller, fn) => {
      const call = serve(tail, caller, fn);
      tail = settle(call);

      return call;
    },
  };
};
