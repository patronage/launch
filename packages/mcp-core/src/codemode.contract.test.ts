import type {
  CodemodeApproveOptions,
  CodemodeRejectOptions,
  CodemodeRuntimeHandle,
  ConnectorTools,
  ExecutionState,
  ExecutionStatus,
  PendingAction,
  ProxyToolOutput,
  ToolExecuteContext,
  ToolLogEntry,
} from "@cloudflare/codemode";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ConnectorToolMap, ToolCallContext } from "./connector";
import { toExecuteResult, toRunView } from "./run";
import type {
  ExecuteResult,
  ExecutionRecord,
  PendingApplyParser,
  ProxyOutcome,
  ProxyPending,
  RunView,
  ToolLogRecord,
} from "./run";

// Contract tests for @cloudflare/codemode (ADR 0014). `run.ts` reads the
// runtime's values through its own package-free mirror types so it can be
// tested under node, and `runtime.ts` and `tool-map-connector.ts` call the
// runtime handle and extend its connector base class. Nothing else would
// notice when an upgrade renames a status, adds one, or reshapes a value, so
// this file pins the part of the package's surface the gateway depends on.
//
// Two kinds of check live here. The `expectTypeOf` assertions do nothing at
// runtime: `pnpm typecheck` is what fails when codemode's declared types stop
// matching. The tables are typed by codemode's own unions, so a status or
// state added to or removed from them is also a type error, and the `it`
// blocks then run every value through the mappers the gateway uses.
//
// The runtime itself (pause, replay, resume) needs workerd, a Durable Object
// facet and a Worker Loader, so its behaviour is not exercised here.

const parse: PendingApplyParser = () => ({
  intent: "Rename the launch page",
  sentences: ["Update title on pages 7"],
});

const applyEntry = (state: ToolLogEntry["state"]): ToolLogEntry => ({
  args: { intent: "Rename the launch page", operations: [] },
  connector: "wp",
  method: "apply",
  requiresApproval: true,
  seq: 1,
  state,
});

const execution = (
  status: ExecutionStatus,
  log: ToolLogEntry[] = []
): ExecutionState => ({
  code: "async () => wp.apply({})",
  createdAt: 0,
  id: "exec_1",
  log,
  status,
  updatedAt: 0,
});

describe("the codemode types the gateway reads through its own", () => {
  it("accepts every value the runtime handle returns", () => {
    expectTypeOf<ProxyToolOutput>().toExtend<ProxyOutcome>();
    expectTypeOf<ExecutionState>().toExtend<ExecutionRecord>();
    expectTypeOf<ToolLogEntry>().toExtend<ToolLogRecord>();
    expectTypeOf<PendingAction>().toExtend<ProxyPending>();
  });

  it("hands connector tools the execution id they read", () => {
    expectTypeOf<ToolExecuteContext>().toExtend<ToolCallContext>();
    expectTypeOf<ToolExecuteContext["executionId"]>().toEqualTypeOf<string>();
  });

  it("takes the gateway's tool maps as connector tools", () => {
    expectTypeOf<ConnectorToolMap>().toExtend<ConnectorTools>();
  });
});

describe("the codemode runtime handle the Durable Object calls", () => {
  it("lists a bounded window of executions, newest first", () => {
    expectTypeOf<CodemodeRuntimeHandle["executions"]>()
      .parameter(0)
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<
      Awaited<ReturnType<CodemodeRuntimeHandle["executions"]>>
    >().toEqualTypeOf<ExecutionState[]>();
  });

  it("approves by execution id and rejects by execution id and seq", () => {
    expectTypeOf<CodemodeApproveOptions>().toEqualTypeOf<{
      executionId: string;
    }>();
    expectTypeOf<CodemodeRejectOptions>().toEqualTypeOf<{
      executionId: string;
      seq: number;
    }>();
  });

  it("answers execute and approve with the same outcome", () => {
    expectTypeOf<
      Awaited<ReturnType<CodemodeRuntimeHandle["execute"]>>
    >().toEqualTypeOf<ProxyToolOutput>();
    expectTypeOf<
      Awaited<ReturnType<CodemodeRuntimeHandle["approve"]>>
    >().toEqualTypeOf<ProxyToolOutput>();
    expectTypeOf<
      Awaited<ReturnType<CodemodeRuntimeHandle["pending"]>>
    >().toEqualTypeOf<PendingAction[]>();
  });
});

// One per `ProxyToolOutput` status. `toExecuteResult` treats every status it
// does not name as complete, so a new one must be mapped here first.
const outcomes: Record<ProxyToolOutput["status"], ProxyToolOutput> = {
  completed: {
    calls: [applyEntry("applied")],
    executionId: "exec_1",
    result: { ok: true },
    status: "completed",
  },
  error: {
    calls: [],
    error: "Codemode replay divergence at step 2",
    executionId: "exec_1",
    status: "error",
  },
  paused: {
    calls: [applyEntry("pending")],
    executionId: "exec_1",
    pending: [
      {
        args: { intent: "Rename the launch page", operations: [] },
        connector: "wp",
        executionId: "exec_1",
        method: "apply",
        seq: 1,
      },
    ],
    status: "paused",
  },
};

const executeStatuses: Record<
  ProxyToolOutput["status"],
  ExecuteResult["status"]
> = {
  completed: "complete",
  error: "error",
  paused: "paused",
};

describe("an execute or approve outcome", () => {
  it.each(Object.values(outcomes))(
    "maps a $status run to its own result status",
    (outcome) => {
      expect(toExecuteResult(parse, outcome).status).toBe(
        executeStatuses[outcome.status]
      );
    }
  );

  it("summarises the pending write of a paused run", () => {
    expect(toExecuteResult(parse, outcomes.paused)).toStrictEqual({
      executionId: "exec_1",
      pending: [
        {
          connector: "wp",
          intent: "Rename the launch page",
          method: "apply",
          sentences: ["Update title on pages 7"],
          seq: 1,
        },
      ],
      status: "paused",
      summary: "Paused for approval: Rename the launch page (1 operation).",
    });
  });

  it("keeps the runtime's own error message", () => {
    expect(toExecuteResult(parse, outcomes.error)).toMatchObject({
      error: "Codemode replay divergence at step 2",
    });
  });
});

// Every `ExecutionStatus`, and what the approval page and `get_run` call it.
// None may read as `unknown`, which the page shows for a run it cannot find.
const runStatuses: Record<ExecutionStatus, RunView["status"]> = {
  completed: "complete",
  error: "error",
  paused: "paused",
  rejected: "error",
  rolled_back: "error",
  running: "running",
};

// Every `ToolLogEntry` state, and whether a paused run offers an apply in it
// for approval. Only a pending entry does.
const awaitsApproval: Record<ToolLogEntry["state"], boolean> = {
  applied: false,
  error: false,
  executing: false,
  pending: true,
  reverted: false,
};

describe("a recorded execution", () => {
  it.each(Object.entries(runStatuses))(
    "reads a %s run as %s",
    (status, expected) => {
      // SAFETY: The keys of `runStatuses` are `ExecutionStatus` values by its type.
      const view = toRunView("exec_1", execution(status as ExecutionStatus));

      expect(view.status).toBe(expected);
    }
  );

  it.each(Object.entries(awaitsApproval))(
    "offers a paused run's %s apply for approval: %s",
    (state, offered) => {
      const view = toRunView(
        "exec_1",
        // SAFETY: The keys of `awaitsApproval` are `ToolLogEntry` states by its type.
        execution("paused", [applyEntry(state as ToolLogEntry["state"])])
      );

      expect(view.pending !== undefined).toBe(offered);
    }
  );

  it("lists every logged call with its connector, method, seq and state", () => {
    const view = toRunView(
      "exec_1",
      execution("completed", [applyEntry("applied")])
    );

    expect(view.calls).toStrictEqual([
      { connector: "wp", method: "apply", seq: 1, state: "applied" },
    ]);
  });
});
