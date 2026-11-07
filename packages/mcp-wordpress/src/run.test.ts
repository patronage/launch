import {
  ApplyConflictError,
  UpstreamRequestError,
  clearRunNonce,
  consumeRunNonce,
  executeSummaryText,
  invalidPendingApply,
  issueRunNonce,
  receiptForSeq,
  runStorageKeys,
  toExecuteResult,
  toRunProblem,
  toRunView,
  verifyRunNonce,
} from "@patronage/mcp-core";
import type { NonceStore, PendingApplyParser } from "@patronage/mcp-core";
import { describe, expect, it } from "vitest";

import { wordpressConnector } from "./wp-gateway";

// The WordPress connector's `apply` validation, as the runtime calls it.
const parse: PendingApplyParser = (_connector, args) =>
  wordpressConnector.parseApply(args);

const applyArgs = {
  intent: "Fix the launch page headline",
  operations: [
    {
      fields: { title: "New" },
      id: 42,
      kind: "update_post",
      rest_base: "pages",
    },
  ],
};

const duplicateArgs = {
  intent: "Retitle the launch page twice",
  operations: [
    {
      fields: { title: "New" },
      id: 42,
      kind: "update_post",
      rest_base: "pages",
    },
    {
      fields: { title: "Newer" },
      id: 42,
      kind: "update_post",
      rest_base: "pages",
    },
  ],
};

const receipt = {
  approverOpaque: "approver00000000",
  executionId: "exec_5",
  operations: [],
  requesterOpaque: "requester0000000",
  status: "succeeded",
};

describe(toExecuteResult, () => {
  it("maps a completed outcome to the complete branch", () => {
    expect(
      toExecuteResult(parse, {
        calls: [
          { connector: "wp", method: "graphql", seq: 1, state: "applied" },
        ],
        executionId: "exec_1",
        result: { count: 2 },
        status: "completed",
      })
    ).toStrictEqual({
      calls: [{ connector: "wp", method: "graphql", seq: 1, state: "applied" }],
      result: { count: 2 },
      status: "complete",
    });
  });

  it("maps a paused outcome to model-visible approval details", () => {
    const result = toExecuteResult(parse, {
      executionId: "exec_2",
      pending: [{ args: applyArgs, connector: "wp", method: "apply", seq: 3 }],
      status: "paused",
    });

    expect(result).toStrictEqual({
      executionId: "exec_2",
      pending: [
        {
          connector: "wp",
          intent: "Fix the launch page headline",
          method: "apply",
          sentences: ["Update title on pages 42"],
          seq: 3,
        },
      ],
      status: "paused",
      summary:
        "Paused for approval: Fix the launch page headline (1 operation).",
    });
  });

  it("summarizes unparsable pending arguments without throwing", () => {
    const result = toExecuteResult(parse, {
      executionId: "exec_3",
      pending: [
        { args: { nope: true }, connector: "wp", method: "apply", seq: 1 },
      ],
      status: "paused",
    });

    expect(result.status).toBe("paused");

    if (result.status !== "paused") {
      return;
    }

    expect(result.pending[0]?.sentences).toStrictEqual([]);
    expect(result.pending[0]?.intent).toBe("unparsable apply arguments");
  });

  it("maps an error outcome and renders a one-line summary", () => {
    const result = toExecuteResult(parse, {
      calls: [],
      error: "TypeError: wp.nope is not a function",
      executionId: "exec_4",
      status: "error",
    });

    expect(result).toStrictEqual({
      calls: [],
      error: "TypeError: wp.nope is not a function",
      status: "error",
    });
    expect(executeSummaryText(result)).toBe(
      "Run failed: TypeError: wp.nope is not a function"
    );
  });
});

describe(invalidPendingApply, () => {
  it("passes a paused run whose pending wp.apply arguments parse", () => {
    expect(
      invalidPendingApply(parse, {
        executionId: "exec_10",
        pending: [
          { args: applyArgs, connector: "wp", method: "apply", seq: 3 },
        ],
        status: "paused",
      })
    ).toBeUndefined();
  });

  it("reports a batch that addresses one post twice as duplicate_target", () => {
    const problem = invalidPendingApply(parse, {
      executionId: "exec_11",
      pending: [
        { args: duplicateArgs, connector: "wp", method: "apply", seq: 4 },
      ],
      status: "paused",
    });

    expect(problem?.code).toBe("duplicate_target");
    expect(problem?.seq).toBe(4);
    expect(problem?.message).toContain("pages/42");
  });

  it("reports a payload the schema cannot read as invalid_operations", () => {
    const problem = invalidPendingApply(parse, {
      executionId: "exec_12",
      pending: [
        { args: "not an object", connector: "wp", method: "apply", seq: 1 },
      ],
      status: "paused",
    });

    expect(problem?.code).toBe("invalid_operations");
    expect(problem?.seq).toBe(1);
  });

  it("passes a paused run whose pending action is not an apply", () => {
    expect(
      invalidPendingApply(parse, {
        executionId: "exec_13",
        pending: [
          { args: { nope: true }, connector: "wp", method: "get", seq: 2 },
        ],
        status: "paused",
      })
    ).toBeUndefined();
  });

  it("passes a run that never paused", () => {
    expect(
      invalidPendingApply(parse, {
        calls: [],
        executionId: "exec_14",
        result: { count: 1 },
        status: "completed",
      })
    ).toBeUndefined();
  });
});

describe(executeSummaryText, () => {
  it("summarizes a paused run without exposing an approval URL", () => {
    const paused = toExecuteResult(parse, {
      executionId: "exec_2",
      pending: [{ args: applyArgs, connector: "wp", method: "apply", seq: 3 }],
      status: "paused",
    });

    expect(executeSummaryText(paused)).toBe(
      "Paused for approval: Fix the launch page headline (1 operation)."
    );
  });

  it("summarizes a result that needs no approval", () => {
    const complete = toExecuteResult(parse, {
      calls: [{ connector: "wp", method: "get", seq: 1, state: "applied" }],
      executionId: "exec_1",
      result: null,
      status: "completed",
    });

    expect(executeSummaryText(complete)).toBe(
      "Run complete after 1 connector call(s)."
    );
  });
});

describe(toRunProblem, () => {
  it("keeps the code and message of a typed preflight conflict", () => {
    expect(
      toRunProblem(
        new ApplyConflictError(
          "stale_expected_modified_gmt",
          "pages/42 was last modified at 2026-09-02T09:00:00"
        )
      )
    ).toStrictEqual({
      code: "stale_expected_modified_gmt",
      message: "pages/42 was last modified at 2026-09-02T09:00:00",
    });
  });

  it("keeps the bounded message of a WordPress request failure", () => {
    expect(
      toRunProblem(new UpstreamRequestError("WordPress returned HTTP 403"))
    ).toStrictEqual({
      code: "upstream_request_failed",
      message: "WordPress returned HTTP 403",
    });
  });

  it("never forwards the message of an unrecognised failure", () => {
    expect(
      toRunProblem(new Error("connect ECONNREFUSED 10.0.0.1:443"))
    ).toStrictEqual({
      code: "preflight_failed",
      message: "The approval preview could not be built",
    });
  });
});

describe(toRunView, () => {
  it("reports an unknown run when the durable log has no record", () => {
    expect(toRunView("exec_9")).toStrictEqual({
      calls: [],
      executionId: "exec_9",
      status: "unknown",
    });
  });

  it("lifts the wp.apply receipt out of the tool log", () => {
    expect(
      toRunView("exec_5", {
        id: "exec_5",
        log: [
          { connector: "wp", method: "get", seq: 1, state: "applied" },
          {
            args: applyArgs,
            connector: "wp",
            method: "apply",
            result: receipt,
            seq: 2,
            state: "applied",
          },
        ],
        status: "completed",
      })
    ).toStrictEqual({
      calls: [
        { connector: "wp", method: "get", seq: 1, state: "applied" },
        { connector: "wp", method: "apply", seq: 2, state: "applied" },
      ],
      executionId: "exec_5",
      receipt,
      status: "complete",
      write: { confirmed: 0, status: "succeeded", total: 0 },
    });
  });

  it("reports the write's receipt when the script timed out after it", () => {
    const view = toRunView("exec_6", {
      error: "Execution timed out",
      id: "exec_6",
      log: [
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          result: receipt,
          seq: 1,
          state: "applied",
        },
      ],
      status: "error",
    });

    expect(view.status).toBe("error");
    expect(view.receipt).toStrictEqual(receipt);
    expect(view.receiptInterrupted).toBeUndefined();
    expect(view.write).toStrictEqual({
      confirmed: 0,
      status: "succeeded",
      total: 0,
    });
  });

  const progress = {
    approverOpaque: "approver00000000",
    executionId: "exec_7",
    operations: [
      {
        changed_paths: ["code"],
        kind: "upsert_redirect",
        normalized_paths: [],
        operation_index: 1,
        status: "changed" as const,
        target: "redirect /b",
      },
    ],
    requesterOpaque: "requester0000000",
    startedAt: 1,
    targets: ["redirect /a", "redirect /b", "redirect /c"],
    total: 3,
    updatedAt: 2,
  };

  const executing = {
    args: applyArgs,
    connector: "wp",
    method: "apply",
    seq: 1,
    state: "executing",
  };

  it("reports progress while an approved write is still running", () => {
    const view = toRunView(
      "exec_7",
      { id: "exec_7", log: [executing], status: "running" },
      undefined,
      progress
    );

    expect(view.progress).toStrictEqual(progress);
    expect(view.receipt).toBeUndefined();
    expect(view.write).toStrictEqual({
      confirmed: 1,
      status: "running",
      total: 3,
    });
  });

  it("rebuilds a partial receipt when the run stopped before the write returned", () => {
    const view = toRunView(
      "exec_7",
      {
        error: "Execution timed out",
        id: "exec_7",
        log: [executing],
        status: "error",
      },
      undefined,
      progress
    );

    expect(view.receiptInterrupted).toBeTruthy();
    expect(view.receipt?.status).toBe("partial");
    expect(view.receipt?.operations.map((item) => item.status)).toStrictEqual([
      "unconfirmed",
      "changed",
      "unconfirmed",
    ]);
    expect(view.receipt?.operations[0]).toMatchObject({
      error: { code: "interrupted" },
      target: "redirect /a",
    });
    expect(view.write).toStrictEqual({
      confirmed: 1,
      status: "partial",
      total: 3,
    });
  });

  it("ignores progress while the latest wp.apply is still awaiting approval", () => {
    const view = toRunView(
      "exec_7",
      {
        id: "exec_7",
        log: [{ ...executing, state: "pending" }],
        status: "paused",
      },
      undefined,
      progress
    );

    expect(view.receipt).toBeUndefined();
    expect(view.progress).toBeUndefined();
    expect(view.write).toBeUndefined();
  });

  it("reports no receipt when the latest wp.apply is still pending", () => {
    const view = toRunView("exec_15", {
      id: "exec_15",
      log: [
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          result: receipt,
          seq: 1,
          state: "applied",
        },
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          seq: 2,
          state: "pending",
        },
      ],
      status: "paused",
    });

    expect(view.receipt).toBeUndefined();
    expect(view.status).toBe("paused");
  });

  it("reports no receipt when the latest wp.apply errored", () => {
    const view = toRunView("exec_16", {
      error: "wp.apply failed",
      id: "exec_16",
      log: [
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          result: receipt,
          seq: 1,
          state: "applied",
        },
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          seq: 2,
          state: "error",
        },
      ],
      status: "error",
    });

    expect(view.receipt).toBeUndefined();
    expect(view.error).toBe("wp.apply failed");
  });

  it("ignores a logged wp.apply result that is not a receipt", () => {
    const view = toRunView("exec_7", {
      id: "exec_7",
      log: [
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          result: { ok: true },
          seq: 1,
          state: "applied",
        },
      ],
      status: "completed",
    });

    expect(view.receipt).toBeUndefined();
    expect(view.status).toBe("complete");
  });

  it("exposes the pending operations of a paused run", () => {
    const view = toRunView("exec_6", {
      id: "exec_6",
      log: [
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          seq: 1,
          state: "pending",
        },
      ],
      status: "paused",
    });

    expect(view.status).toBe("paused");
    expect(view.pending?.connector).toBe("wp");
    expect(
      parse(view.pending?.connector ?? "", view.pending?.args).intent
    ).toBe("Fix the launch page headline");
  });

  it("carries the run's stated purpose when storage kept one", () => {
    const view = toRunView(
      "exec_17",
      {
        id: "exec_17",
        log: [
          {
            args: applyArgs,
            connector: "wp",
            method: "apply",
            seq: 1,
            state: "pending",
          },
        ],
        status: "paused",
      },
      "Refresh the launch page for the September push"
    );

    expect(view.intent).toBe("Refresh the launch page for the September push");
  });

  it("omits the stated purpose when storage kept none", () => {
    const view = toRunView("exec_18", {
      id: "exec_18",
      log: [],
      status: "completed",
    });

    expect(view).not.toHaveProperty("intent");
  });

  it("reports a rejected run as a failed run, not an unknown one", () => {
    const view = toRunView("exec_8", {
      error: "Action wp.apply rejected by user",
      id: "exec_8",
      log: [
        {
          args: applyArgs,
          connector: "wp",
          method: "apply",
          seq: 1,
          state: "pending",
        },
      ],
      status: "rejected",
    });

    expect(view.status).toBe("error");
    expect(view.error).toBe("Action wp.apply rejected by user");
    expect(view.pending).toBeUndefined();
  });
});

describe(runStorageKeys, () => {
  it("names every key this Worker writes for one run", () => {
    expect(runStorageKeys("exec_1")).toStrictEqual([
      "intent:exec_1",
      "nonce:exec_1",
      "preflight:exec_1",
      "requester:exec_1",
    ]);
  });
});

describe(receiptForSeq, () => {
  it("returns the receipt of the approved apply, not of the newest one", () => {
    // What `approve` sees the moment it resolves: the write it authorised is
    // applied and a second `wp.apply` is already pending behind it, so the
    // newest apply entry is the one that has written nothing.
    expect(
      receiptForSeq(
        {
          id: "exec_20",
          log: [
            { connector: "wp", method: "get", seq: 1, state: "applied" },
            {
              args: applyArgs,
              connector: "wp",
              method: "apply",
              result: receipt,
              seq: 2,
              state: "applied",
            },
            {
              args: applyArgs,
              connector: "wp",
              method: "apply",
              seq: 3,
              state: "pending",
            },
          ],
          status: "paused",
        },
        2
      )
    ).toStrictEqual(receipt);
  });

  it("returns nothing when the approved apply recorded no receipt", () => {
    expect(
      receiptForSeq(
        {
          error: "wp.apply failed",
          id: "exec_21",
          log: [
            {
              args: applyArgs,
              connector: "wp",
              method: "apply",
              seq: 2,
              state: "error",
            },
          ],
          status: "error",
        },
        2
      )
    ).toBeUndefined();
  });

  it("returns nothing when the record carries no entry with that seq", () => {
    expect(
      receiptForSeq({ id: "exec_22", log: [], status: "completed" }, 2)
    ).toBeUndefined();
  });

  it("ignores a logged result that is not a receipt", () => {
    expect(
      receiptForSeq(
        {
          id: "exec_23",
          log: [
            {
              args: applyArgs,
              connector: "wp",
              method: "apply",
              result: { ok: true },
              seq: 2,
              state: "applied",
            },
          ],
          status: "completed",
        },
        2
      )
    ).toBeUndefined();
  });
});

interface StubbedNonceStore {
  keys: Map<string, string>;
  store: NonceStore;
}

// The Durable Object's storage, as the approval token sees it.
const nonceStore = (): StubbedNonceStore => {
  const keys = new Map<string, string>();

  const store: NonceStore = {
    delete: (key) => {
      keys.delete(key);

      return Promise.resolve();
    },
    read: (key) => Promise.resolve(keys.get(key)),
    write: (key, digest) => {
      keys.set(key, digest);

      return Promise.resolve();
    },
  };

  return { keys, store };
};

describe("the approval token's lifecycle", () => {
  it("keeps only the digest, never the token itself", async () => {
    const { keys, store } = nonceStore();

    const nonce = await issueRunNonce(store, "exec_1");

    expect(nonce).toMatch(/^[0-9a-f]{64}$/u);
    expect([...keys.keys()]).toStrictEqual(["nonce:exec_1"]);
    expect(keys.get("nonce:exec_1")).not.toBe(nonce);
  });

  it("answers a preview without spending the token", async () => {
    const { store } = nonceStore();
    const nonce = await issueRunNonce(store, "exec_1");

    await expect(verifyRunNonce(store, "exec_1", nonce)).resolves.toBeTruthy();
    await expect(verifyRunNonce(store, "exec_1", nonce)).resolves.toBeTruthy();
    await expect(
      verifyRunNonce(store, "exec_1", "00".repeat(32))
    ).resolves.toBeFalsy();
  });

  it("spends the token on the first decision and no other", async () => {
    const { store } = nonceStore();
    const nonce = await issueRunNonce(store, "exec_1");

    await expect(consumeRunNonce(store, "exec_1", nonce)).resolves.toBeTruthy();
    await expect(consumeRunNonce(store, "exec_1", nonce)).resolves.toBeFalsy();
    await expect(verifyRunNonce(store, "exec_1", nonce)).resolves.toBeFalsy();
  });

  it("leaves the token untouched when the wrong one is presented", async () => {
    const { store } = nonceStore();
    const nonce = await issueRunNonce(store, "exec_1");

    await expect(
      consumeRunNonce(store, "exec_1", "00".repeat(32))
    ).resolves.toBeFalsy();
    await expect(consumeRunNonce(store, "exec_1", nonce)).resolves.toBeTruthy();
  });

  // What the browser approval page's decision does: it spends no token of its
  // own, so a run that pauses again must not still answer to the token minted
  // for the pause before it.
  it("retires the token on a decision made anywhere", async () => {
    const { store } = nonceStore();
    const first = await issueRunNonce(store, "exec_1");

    await clearRunNonce(store, "exec_1");
    const second = await issueRunNonce(store, "exec_1");

    await expect(verifyRunNonce(store, "exec_1", first)).resolves.toBeFalsy();
    await expect(verifyRunNonce(store, "exec_1", second)).resolves.toBeTruthy();
  });

  it("answers no token for a run that has none on record", async () => {
    const { store } = nonceStore();

    await expect(
      verifyRunNonce(store, "exec_9", "00".repeat(32))
    ).resolves.toBeFalsy();
  });
});
