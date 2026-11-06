import { describe, expect, it } from "vitest";

import { batchStatus } from "./apply";
import type { OperationReceipt } from "./apply";
import { delay, mapWithConcurrency } from "./concurrency";

describe(mapWithConcurrency, () => {
  it("never runs more than the limit and answers in input order", async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency(
      [30, 5, 20, 1, 10],
      2,
      async (ms, index) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(ms);
        inFlight -= 1;

        return index;
      }
    );

    expect(peak).toBe(2);
    expect(results).toStrictEqual([0, 1, 2, 3, 4]);
  });

  it("answers an empty list without running anything", async () => {
    await expect(
      mapWithConcurrency([], 2, () => Promise.resolve(1))
    ).resolves.toStrictEqual([]);
  });
});

const receipt = (status: OperationReceipt["status"]): OperationReceipt => ({
  changed_paths: [],
  kind: "update_post",
  normalized_paths: [],
  operation_index: 0,
  status,
  target: "pages/1",
});

describe(batchStatus, () => {
  it("never calls a batch failed while an operation is unconfirmed", () => {
    expect(batchStatus([receipt("unconfirmed")])).toBe("partial");
    expect(batchStatus([receipt("changed"), receipt("unconfirmed")])).toBe(
      "partial"
    );
    expect(batchStatus([receipt("failed"), receipt("conflict")])).toBe(
      "failed"
    );
    expect(batchStatus([receipt("changed"), receipt("unchanged")])).toBe(
      "succeeded"
    );
  });
});
