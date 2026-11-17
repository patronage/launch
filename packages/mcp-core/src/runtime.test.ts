/* oxlint-disable max-classes-per-file -- the two module stand-ins and the deployment subclass under test. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preflightDigest } from "./apply";
import type { ApplyPreflight, BatchReceipt, OperationReceipt } from "./apply";
import type { CallerContext } from "./caller";
import { delay, mapWithConcurrency } from "./concurrency";
import type { ConnectorToolMap } from "./connector";
import type { GatewayEnv } from "./env";
import { CLOSED_RETENTION_MS, MAX_OPEN_PER_SUBMITTER } from "./feedback";
import type { GatewayConnector } from "./gateway-connector";
import { PAUSED_MAX_AGE_MS } from "./run";
import type { ExecutionRecord, RunReport, ToolLogRecord } from "./run";
import { BaseGatewayRuntime } from "./runtime";
import { testGatewayEnv } from "./test-env";

// `BaseGatewayRuntime` composes the pure helpers in `run.ts` with Durable
// Object storage and the codemode runtime handle. Neither `cloudflare:workers`
// nor a Worker Loader exists under node, so both are replaced: the Durable
// Object base class by one that only keeps `ctx` and `env`, and the codemode
// runtime by an in-memory log that pauses every `requiresApproval` call, runs
// it on approval, and gives up on the pass after the executor's timeout while
// the write itself keeps going, as the real sandbox does. Storage is a Map.
//
// Module mocks stand in for dependency injection here because the runtime
// imports both modules directly, and running the real codemode runtime needs
// workerd (a SQLite facet and a Worker Loader).

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- `cloudflare:workers` exists only inside workerd.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: DurableObjectState;
    readonly env: GatewayEnv;

    constructor(ctx: DurableObjectState, env: GatewayEnv) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/* oxlint-disable unicorn/consistent-function-scoping -- `vi.hoisted` runs before module scope exists, so its helpers live inside it. */
const fakeCodemode = vi.hoisted(() => {
  type Execution = ExecutionRecord & {
    createdAt: number;
    log: ToolLogRecord[];
    order: number;
    updatedAt: number;
  };

  // The durable log lives in a facet beside the object's own storage, so it
  // is kept here by storage object and never shows up in a scan of it.
  const logs = new WeakMap<DurableObjectStorage, Execution[]>();
  let order = 0;

  // Whether the sandbox gave up on its pass before `work` settled. Imports
  // are not in reach of a hoisted block, so the timer is written out.
  const timesOut = (work: Promise<void>, ms: number): Promise<boolean> =>
    Promise.race([
      work.then(() => false),
      // oxlint-disable-next-line promise/avoid-new -- a sandbox pass timer.
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), ms);
      }),
    ]);

  abstract class CodemodeConnector {
    readonly ctx: DurableObjectState | ExecutionContext;
    readonly env: GatewayEnv;

    constructor(ctx: DurableObjectState | ExecutionContext, env: GatewayEnv) {
      this.ctx = ctx;
      this.env = env;
    }

    protected abstract tools(): ConnectorToolMap;

    toolMap(): ConnectorToolMap {
      return this.tools();
    }
  }

  const pendingOf = (run: Execution) =>
    run.log.flatMap(({ args, connector, method, seq, state }) =>
      state === "pending" ? [{ args, connector, method, seq }] : []
    );

  class DynamicWorkerExecutor {
    readonly timeout: number;

    constructor({ timeout }: { timeout: number }) {
      this.timeout = timeout;
    }
  }

  const createCodemodeRuntime = ({
    connectors,
    ctx,
    executor,
  }: {
    connectors: (CodemodeConnector & { name: () => string })[];
    ctx: { storage: DurableObjectStorage };
    executor: DynamicWorkerExecutor;
  }) => {
    const executions = logs.get(ctx.storage) ?? [];
    logs.set(ctx.storage, executions);
    const find = (id: string) => executions.find((run) => run.id === id);

    const output = (run: Execution) => ({
      calls: run.log,
      error: run.error,
      executionId: run.id,
      pending: pendingOf(run),
      result: run.result,
      status: run.status,
    });

    return {
      approve: async ({ executionId }: { executionId: string }) => {
        const run = find(executionId);
        const entry = run?.log.find((item) => item.state === "pending");

        if (!(run && entry)) {
          throw new Error("No pending action");
        }

        const tool = connectors
          .find((connector) => connector.name() === entry.connector)
          ?.toolMap()[entry.method];

        if (!tool) {
          throw new Error("No such tool");
        }

        entry.state = "running";
        run.status = "running";
        run.updatedAt = Date.now();

        // The tool runs in the host, so its result is logged whenever it
        // lands, even after the sandbox has given up on the pass.
        const landed = (async () => {
          try {
            const result = await tool.execute(structuredClone(entry.args));

            entry.result = result;
            entry.state = "applied";
            run.updatedAt = Date.now();

            if (run.status === "running") {
              run.status = "completed";
              run.result = result;
            }
          } catch (error) {
            entry.state = "failed";

            if (run.status === "running") {
              run.status = "error";
              run.error = String(error);
            }
          }
        })();

        if (await timesOut(landed, executor.timeout)) {
          run.status = "error";
          run.error = "Execution timed out";
        }

        return output(run);
      },
      execute: ({ code }: { code: string }) => {
        // SAFETY: every script in this file is written by `script` below.
        const call = JSON.parse(code) as {
          args: unknown;
          connector: string;
          method: string;
        };

        order += 1;
        const now = Date.now();

        const run: Execution = {
          createdAt: now,
          id: `exec_${order}`,
          log: [
            {
              args: call.args,
              connector: call.connector,
              method: call.method,
              seq: 1,
              state: "pending",
            },
          ],
          order,
          status: "paused",
          updatedAt: now,
        };

        executions.push(run);

        return Promise.resolve(output(run));
      },
      executions: (limit?: number) =>
        Promise.resolve(
          executions
            .toSorted((left, right) => right.order - left.order)
            .slice(0, limit)
            .map((run) => structuredClone(run))
        ),
      expirePaused: ({ maxAgeMs }: { maxAgeMs: number }) => {
        const expired = executions.filter(
          (run) =>
            run.status === "paused" && Date.now() - run.updatedAt > maxAgeMs
        );

        for (const run of expired) {
          run.status = "rejected";
          run.error = "Expired without a decision";
        }

        return Promise.resolve(expired.map((run) => run.id));
      },
      pending: (executionId: string) => {
        const run = find(executionId);

        return Promise.resolve(run ? pendingOf(run) : []);
      },
      reject: ({ executionId, seq }: { executionId: string; seq: number }) => {
        const run = find(executionId);

        const entry = run?.log.find(
          (item) => item.seq === seq && item.state === "pending"
        );

        if (!(run && entry)) {
          return Promise.resolve(false);
        }

        entry.state = "rejected";
        run.status = "rejected";
        run.error = "Rejected by the approver";

        return Promise.resolve(true);
      },
    };
  };

  return { CodemodeConnector, createCodemodeRuntime, DynamicWorkerExecutor };
});
/* oxlint-enable unicorn/consistent-function-scoping */

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- the real runtime needs workerd; see above.
vi.mock("@cloudflare/codemode", () => fakeCodemode);

// ---------------------------------------------------------------- storage

// Durable Object storage hands back copies, never the stored object.
const copy = <T>(value: T): T =>
  value === undefined ? value : structuredClone(value);

const memoryStorage = () => {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;

  const storage = {
    delete: (keys: string | string[]) => {
      if (Array.isArray(keys)) {
        return Promise.resolve(keys.filter((key) => values.delete(key)).length);
      }

      return Promise.resolve(values.delete(keys));
    },
    get: (key: string) => Promise.resolve(copy(values.get(key))),
    getAlarm: () => Promise.resolve(alarm),
    list: ({ prefix }: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...values].flatMap(([key, value]) =>
            key.startsWith(prefix) ? [[key, copy(value)] as const] : []
          )
        )
      ),
    put: <T>(key: string, value: T) => {
      values.set(key, copy(value));

      return Promise.resolve();
    },
    setAlarm: (at: number) => {
      alarm = at;

      return Promise.resolve();
    },
  };

  return { storage, values };
};

// ---------------------------------------------------------------- fixtures

const REQUESTER_EMAIL = "requester@example.com";
const APPROVER_EMAIL = "approver@example.com";

const base64url = (value: Record<string, string>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// Shaped like an Access JWT, with the email in its payload, so a scan of
// storage for either finds any copy of it.
const fakeJwt = (email: string): string =>
  `${base64url({ alg: "RS256" })}.${base64url({ email, sub: email })}.c2lnbmF0dXJl`;

const requester: CallerContext = {
  subjectOpaque: "subject-requester",
  token: fakeJwt(REQUESTER_EMAIL),
};

const approver: CallerContext = {
  subjectOpaque: "subject-approver",
  token: fakeJwt(APPROVER_EMAIL),
};

interface Operation {
  target: string;
  title: string;
}

interface ApplyArgs {
  intent: string;
  operations: Operation[];
}

const applyArgs = (intent = "Retitle the launch page"): ApplyArgs => ({
  intent,
  operations: [
    { target: "pages/7", title: "Launch week" },
    { target: "pages/8", title: "Launch recap" },
  ],
});

// The fake sandbox runs the script `{ connector, method, args }` names. A
// request may carry more than the script needs, so a `note` rides along to
// prove only what the runtime chose to keep reaches storage.
const script = (args: ApplyArgs, note = "request body text"): string =>
  JSON.stringify({ args, connector: "wp", method: "apply", note });

interface HarnessState {
  // How long each operation of the write takes to land.
  operationMs: number;
  preflights: number;
  storage: ReturnType<typeof memoryStorage>["storage"];
  values: Map<string, unknown>;
  // Every write that reached the CMS, as the caller it ran under saw it.
  writes: { approver: string; args: ApplyArgs; requester: string }[];
}

interface Harness extends HarnessState {
  runtime: BaseGatewayRuntime;
}

const APPROVAL_TIMEOUT_MS = 1000;
const SETTLE_GRACE_MS = 5000;

const harness = (previous?: HarnessState): Harness => {
  const { storage, values } = previous ?? memoryStorage();

  const state: HarnessState = previous ?? {
    operationMs: 0,
    preflights: 0,
    storage,
    values,
    writes: [],
  };

  const connector: GatewayConnector = {
    configured: () => true,
    describe: () => Promise.resolve({ postTypes: ["page", "post"] }),
    executeDescription: "Write with wp.apply.",
    instructions: "",
    name: "wp",
    parseApply: <T>(args: T) => {
      // SAFETY: every script in this file passes `ApplyArgs`.
      const { intent, operations } = args as T & ApplyArgs;

      return {
        intent,
        sentences: operations.map(
          (operation) => `Update title on ${operation.target}`
        ),
      };
    },
    // Each rebuild is a new preview, as a CMS edited meanwhile would give.
    preflight: <T>(_env: GatewayEnv, _caller: CallerContext, args: T) => {
      // SAFETY: every script in this file passes `ApplyArgs`.
      const { intent, operations } = args as T & ApplyArgs;
      state.preflights += 1;

      const preflight: ApplyPreflight = {
        intent,
        operations: operations.map((operation, index) => ({
          editUrl: `https://cms.example/edit/${operation.target}`,
          fields: [
            {
              after: operation.title,
              before: `Draft ${state.preflights}`,
              changed: true,
              path: "title",
            },
          ],
          modifiedGmt: `2026-11-0${state.preflights}T10:00:00`,
          operationIndex: index,
          sentence: `Update title on ${operation.target}`,
          slug: operation.target.replace("/", "-"),
          target: operation.target,
        })),
      };

      return Promise.resolve(preflight);
    },
    tools: ({ scope, store }): ConnectorToolMap => ({
      apply: {
        description: "Apply a batch",
        execute: async <T>(raw: T) => {
          // SAFETY: every script in this file passes `ApplyArgs`.
          const args = raw as T & ApplyArgs;
          const caller = scope.require();
          const executionId = caller.executionId ?? "none";

          const requesterOpaque =
            (await store.readRequester(executionId)) ?? "unknown";

          // One operation at a time, each reporting as it lands.
          const operations = await mapWithConcurrency(
            args.operations,
            1,
            async (operation, index) => {
              if (state.operationMs > 0) {
                await delay(state.operationMs);
              }

              const receipt: OperationReceipt = {
                changed_paths: ["title"],
                kind: "update",
                normalized_paths: [],
                operation_index: index,
                status: "changed",
                target: operation.target,
              };

              await store.recordProgress?.(executionId, receipt);

              return receipt;
            }
          );

          state.writes.push({
            approver: caller.subjectOpaque,
            args,
            requester: requesterOpaque,
          });

          const batch: BatchReceipt = {
            approverOpaque: caller.subjectOpaque,
            executionId,
            operations,
            requesterOpaque,
            status: "succeeded",
          };

          return batch;
        },
        inputSchema: { type: "object" },
        requiresApproval: true,
      },
    }),
  };

  class TestRuntime extends BaseGatewayRuntime {
    protected readonly connectors = [connector];
    protected override readonly approvalTimeoutMs = APPROVAL_TIMEOUT_MS;
    protected override readonly applySettleGraceMs = SETTLE_GRACE_MS;
  }

  // SAFETY: the runtime reaches only `ctx.storage`, and only the members the
  // in-memory storage above implements.
  const ctx = { storage } as DurableObjectState;

  return Object.assign(state, {
    runtime: new TestRuntime(ctx, testGatewayEnv()),
  });
};

const pause = async (
  { runtime }: Harness,
  args: ApplyArgs = applyArgs()
): Promise<string> => {
  const { value } = await runtime.execute(script(args), args.intent, requester);

  if (value.status !== "paused") {
    throw new Error(`Expected a paused run, got ${value.status}`);
  }

  return value.executionId;
};

// What the inline approval card's `decide_write` does: the token is spent
// before the runtime is touched, and a refused token decides nothing.
const decideWithToken = async (
  { runtime }: Harness,
  executionId: string,
  token: string,
  decision: "approve" | "reject"
): Promise<RunReport | "refused"> => {
  if (!(await runtime.consumeNonce(executionId, token))) {
    return "refused";
  }

  const outcome =
    decision === "approve"
      ? await runtime.approve(executionId, approver)
      : await runtime.reject(executionId, approver);

  return outcome.value;
};

const snapshot = (values: Map<string, unknown>) =>
  structuredClone(new Map(values));

describe(BaseGatewayRuntime, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("approving a paused run with the inline card's token", () => {
    it("approves exactly once, and a replay of the same token is refused and writes nothing", async () => {
      const run = harness();
      const executionId = await pause(run);
      const token = await run.runtime.issueNonce(executionId);

      const first = await decideWithToken(run, executionId, token, "approve");

      expect(first).toMatchObject({ status: "complete" });
      expect(run.writes).toHaveLength(1);

      const before = snapshot(run.values);
      const replay = await decideWithToken(run, executionId, token, "approve");

      expect(replay).toBe("refused");
      expect(run.writes).toHaveLength(1);
      expect(run.values).toStrictEqual(before);
    });

    it("records the requester and the approver on the receipt of the write it approved", async () => {
      const run = harness();
      const executionId = await pause(run);

      const { value } = await run.runtime.approve(executionId, approver);

      expect(value.approvedReceipt).toMatchObject({
        approverOpaque: approver.subjectOpaque,
        executionId,
        requesterOpaque: requester.subjectOpaque,
        status: "succeeded",
      });
      expect(run.writes).toStrictEqual([
        {
          approver: approver.subjectOpaque,
          args: applyArgs(),
          requester: requester.subjectOpaque,
        },
      ]);
    });

    it("retires the token on an approval made from the browser page, which spends none", async () => {
      const run = harness();
      const executionId = await pause(run);
      const token = await run.runtime.issueNonce(executionId);

      await run.runtime.approve(executionId, approver);

      await expect(
        run.runtime.verifyNonce(executionId, token)
      ).resolves.toBeFalsy();
    });
  });

  describe("a decision bound to the preview its approver saw", () => {
    it("reports an approval of an earlier preview as stale, invokes no write, and leaves the run paused", async () => {
      const run = harness();
      const executionId = await pause(run);

      const shown = await run.runtime.getRun(executionId, approver);
      const shownDigest = await preflightDigest(shown.value.preflight);
      // The page is loaded again, which rebuilds the preview from the CMS.
      await run.runtime.getRun(executionId, approver);

      const { value } = await run.runtime.approve(
        executionId,
        approver,
        shownDigest
      );

      expect(value).toMatchObject({ stalePreview: true, status: "paused" });
      expect(run.writes).toHaveLength(0);
      await expect(run.runtime.getRun(executionId)).resolves.toMatchObject({
        value: { status: "paused" },
      });
    });

    it("approves when the digest names the preview stored now", async () => {
      const run = harness();
      const executionId = await pause(run);

      const shown = await run.runtime.getRun(executionId, approver);

      const { value } = await run.runtime.approve(
        executionId,
        approver,
        await preflightDigest(shown.value.preflight)
      );

      expect(value.stalePreview).toBeUndefined();
      expect(value.status).toBe("complete");
      expect(run.writes).toHaveLength(1);
    });
  });

  describe("rejecting a paused run", () => {
    it("clears the token, so a later approval with it is refused and nothing is written", async () => {
      const run = harness();
      const executionId = await pause(run);
      const token = await run.runtime.issueNonce(executionId);

      const { value } = await run.runtime.reject(executionId, approver);

      expect(value.status).toBe("error");
      await expect(
        decideWithToken(run, executionId, token, "approve")
      ).resolves.toBe("refused");
      expect(run.writes).toHaveLength(0);
    });
  });

  describe("a write still in flight when the sandbox gives up on its pass", () => {
    it("waits within the grace period and reports the receipt the write produced, not a timeout", async () => {
      const run = harness();
      // Two operations of 1.5 s each: the sandbox gives up after 1 s, and the
      // write lands at 3 s, inside the 5 s grace.
      run.operationMs = 1500;
      const executionId = await pause(run);
      // The approval page builds the preview, which names the targets.
      await run.runtime.getRun(executionId, approver);

      const approving = run.runtime.approve(executionId, approver);
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 600);

      // Mid-flight, the run shows the write's progress, naming both people.
      const midway = await run.runtime.getRun(executionId);

      expect(midway.value).toMatchObject({
        progress: {
          approverOpaque: approver.subjectOpaque,
          requesterOpaque: requester.subjectOpaque,
        },
        write: { confirmed: 1, status: "running", total: 2 },
      });

      await vi.advanceTimersByTimeAsync(1500);
      const { value } = await approving;

      expect(value.receiptInterrupted).toBeUndefined();
      expect(value.write).toStrictEqual({
        confirmed: 2,
        status: "succeeded",
        total: 2,
      });
      expect(value.approvedReceipt).toMatchObject({
        operations: [
          { status: "changed", target: "pages/7" },
          { status: "changed", target: "pages/8" },
        ],
        status: "succeeded",
      });
      expect(run.writes).toHaveLength(1);
    });

    it("stops waiting at the end of the grace period and reports the write as still running", async () => {
      const run = harness();
      // The second operation would land at 8 s, past the 1 s timeout plus 5 s grace.
      run.operationMs = 4000;
      const executionId = await pause(run);
      // The approval page builds the preview, which names the targets.
      await run.runtime.getRun(executionId, approver);

      const approving = run.runtime.approve(executionId, approver);
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + SETTLE_GRACE_MS);
      const { value } = await approving;

      expect(value.approvedReceipt).toBeUndefined();
      expect(value.write).toStrictEqual({
        confirmed: 1,
        status: "running",
        total: 2,
      });
    });
  });

  describe("feedback storage", () => {
    const submission = {
      category: "docs_gap",
      summary: "Paging is undocumented",
      tool: "execute",
    } as const;

    it("starts retention cleanup before any execute call and prunes resolved feedback after a restart", async () => {
      const run = harness();
      await expect(run.storage.getAlarm()).resolves.toBeNull();

      const filed = await run.runtime.submitFeedback(
        submission,
        requester.subjectOpaque
      );

      const stillOpen = await run.runtime.submitFeedback(
        submission,
        requester.subjectOpaque
      );

      await expect(run.storage.getAlarm()).resolves.toBe(
        Date.now() + PAUSED_MAX_AGE_MS
      );
      await run.runtime.updateFeedback(filed.id, {
        status: "resolved",
        note: "Documented",
        version: "0.3.0",
      });

      // Reconstruct the runtime with the same durable storage.
      const restarted = harness(run);
      vi.setSystemTime(Date.now() + CLOSED_RETENTION_MS + 1);
      await restarted.runtime.alarm();
      await expect(
        restarted.runtime.getFeedback(filed.id, requester.subjectOpaque)
      ).resolves.toBeUndefined();
      await expect(
        restarted.runtime.getFeedback(stillOpen.id, requester.subjectOpaque)
      ).resolves.toMatchObject({ status: "open" });
      expect(run.writes).toHaveLength(0);
    });

    it("shares one queue across concurrent feedback RPCs", async () => {
      const run = harness();

      const results = await Promise.allSettled(
        Array.from({ length: MAX_OPEN_PER_SUBMITTER + 1 }, () =>
          run.runtime.submitFeedback(submission, requester.subjectOpaque)
        )
      );

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(MAX_OPEN_PER_SUBMITTER);
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1);
      await expect(
        run.runtime.listOwnFeedback(requester.subjectOpaque)
      ).resolves.toHaveLength(MAX_OPEN_PER_SUBMITTER);
    });
  });

  describe("the alarm", () => {
    it("expires a paused run older than PAUSED_MAX_AGE_MS and leaves a fresh one alone", async () => {
      const run = harness();
      const old = await pause(run, applyArgs("Retitle the old page"));

      vi.setSystemTime(Date.now() + PAUSED_MAX_AGE_MS - 3_600_000);
      const fresh = await pause(run, applyArgs("Retitle the fresh page"));
      vi.setSystemTime(Date.now() + 3_600_001);

      await run.runtime.alarm();

      await expect(run.runtime.getRun(old)).resolves.toMatchObject({
        value: { status: "error" },
      });
      await expect(run.runtime.getRun(fresh)).resolves.toMatchObject({
        value: { intent: "Retitle the fresh page", status: "paused" },
      });
      expect(
        [...run.values.keys()].filter((key) => key.endsWith(`:${old}`))
      ).toStrictEqual([]);
      expect(run.values.get(`requester:${fresh}`)).toBe(
        requester.subjectOpaque
      );
      await expect(run.storage.getAlarm()).resolves.toBe(
        Date.now() + PAUSED_MAX_AGE_MS
      );
    });
  });

  describe("the run listing window", () => {
    // Documents the known limit: `#record` lists the newest 100 runs, so the
    // oldest of more than 100 open approvals cannot be found until the alarm
    // expires it.
    it("reads an old paused run as unknown once more than 100 runs are recorded", async () => {
      const run = harness();
      const oldest = await pause(run);
      const second = await pause(run);

      await Promise.all(Array.from({ length: 99 }, () => pause(run)));

      await expect(run.runtime.getRun(oldest)).resolves.toMatchObject({
        value: { status: "unknown" },
      });
      await expect(run.runtime.getRun(second)).resolves.toMatchObject({
        value: { status: "paused" },
      });
      // Its keys are kept: `unknown` is not an ending.
      expect(run.values.has(`requester:${oldest}`)).toBeTruthy();
    });
  });

  describe("what the runtime keeps in Durable Object storage", () => {
    it("holds no JWT, no email, no request body and no approval token in clear", async () => {
      const run = harness();
      const approved = await pause(run);
      const open = await pause(run, applyArgs("Retitle the pricing page"));
      const token = await run.runtime.issueNonce(open);

      await run.runtime.describeSite(requester);
      await run.runtime.getRun(approved, approver);
      await run.runtime.getRun(open, approver);
      await run.runtime.approve(approved, approver);

      const stored = JSON.stringify([...run.values]);

      expect(run.values.size).toBeGreaterThan(0);

      for (const secret of [
        requester.token,
        approver.token,
        REQUESTER_EMAIL,
        APPROVER_EMAIL,
        "request body text",
        token,
      ]) {
        expect(stored).not.toContain(secret);
      }
    });
  });
});
