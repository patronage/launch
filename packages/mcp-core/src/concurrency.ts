// How many operations of one `apply` a connector runs at once. Two keeps a
// batch of twenty well inside the approval time limit on a slow CMS host, and
// adds one PHP worker's worth of load to the site rather than a burst. A
// batch never addresses one target twice (`parseApplyInput` refuses it), so
// two operations in flight never race on the same record.
export const APPLY_CONCURRENCY = 2;

// Runs `task` over every item with at most `limit` in flight and answers in
// input order, whatever order the tasks finish in. Each lane takes the next
// unclaimed index when its task settles, so one slow item holds up one lane
// and never the batch. A task is expected to settle rather than throw: the
// first rejection rejects the whole map, as `Promise.all` does.
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Map<number, R>();
  let claimed = 0;

  const lane = async (): Promise<void> => {
    const index = claimed;

    if (index >= items.length) {
      return;
    }

    claimed += 1;
    // SAFETY: `index` is below `items.length`, checked just above.
    results.set(index, await task(items[index] as T, index));
    await lane();
  };

  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: lanes }, lane));

  // SAFETY: every index below `items.length` was claimed by exactly one lane
  // and set before that lane moved on.
  return items.map((_, index) => results.get(index) as R);
};

// A wait that can be cut short. Every runtime this module runs in — a Worker,
// Node under vitest, the approval card's frame — has `setTimeout`, and not all
// of them have a promise form of it.
export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps setTimeout, which has no promise form in every runtime this runs in.
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

const quietly = async <T>(work: Promise<T>): Promise<void> => {
  try {
    await work;
  } catch {
    // The caller reads the outcome from where the work recorded it.
  }
};

// Waits for `work` to settle, but no longer than `ms`, and never throws.
export const settleWithin = async <T>(
  work: Promise<T> | undefined,
  ms: number
): Promise<void> => {
  if (!work || ms <= 0) {
    return;
  }

  const stop = new AbortController();

  try {
    await Promise.race([quietly(work), delay(ms, stop.signal)]);
  } finally {
    stop.abort();
  }
};
