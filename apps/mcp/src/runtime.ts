import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
} from "@cloudflare/codemode";
import { DurableObject } from "cloudflare:workers";

import { preflightDigest, preflightOperations } from "./apply";
import type { ApplyPreflight } from "./apply";
import { createCallerScope } from "./caller";
import type { CallerContext } from "./caller";
import { createWordPressTools } from "./connector";
import type { RuntimeStore } from "./connector";
import { buildSiteDescription, DESCRIBE_TTL_MS, isFresh } from "./describe";
import type { SiteDescription } from "./describe";
import { createPayloadClient, payloadConfigured } from "./payload";
import { preflightDraftOperations } from "./payload-apply";
import { PayloadConnector } from "./payload-connector";
import { createPayloadTools, payloadAdminLink } from "./payload-tools";
import {
  clearRunNonce,
  consumeRunNonce,
  intentKey,
  invalidPendingApply,
  isApplyCall,
  issueRunNonce,
  PAUSED_MAX_AGE_MS,
  preflightKey,
  receiptForSeq,
  requesterKey,
  runStorageKeys,
  toExecuteResult,
  toRunProblem,
  toRunView,
  verifyRunNonce,
} from "./run";
import type {
  ExecuteResult,
  ExecutionRecord,
  NonceStore,
  RunReport,
  RuntimeOutcome,
} from "./run";
import { createWordPressClient, createWordPressTelemetry } from "./wordpress";
import type { WordPressClient, WordPressTelemetry } from "./wordpress";
import { WordPressConnector } from "./wp-connector";

interface CachedDescription {
  at: number;
  value: SiteDescription;
}

// How many runs `#record` lists to find one. `CodemodeRuntimeHandle` in
// @cloudflare/codemode 0.5.1 declares `executions(limit?)` and no read that
// takes an id (`getExecution` lives on the facet class, reachable only through
// the package's own internal, undocumented facet name), so a bounded listing
// is the public way to read one run. Hydrating the whole unbounded list to
// answer one approval page is what this bound replaces. Terminal runs are
// pruned to the newest 50 by the runtime's own retention, so the window holds
// every one of those plus 50 more; paused runs are exempt from that pruning
// and only expire after 24 hours, so a deployment holding more than about 50
// open approvals at once can push the oldest of them past the window. Such a
// run reports `unknown` — its approval page 404s — until `alarm` expires it.
const RECORD_WINDOW = 100;

// Every WordPress request one RPC makes is collected on that RPC's telemetry
// and returned beside its result, because the Worker no longer talks to
// WordPress and has no other way to put the `wordpress` field on its wide
// event. An RPC that made no request (a cache hit, a read of a stored run)
// reports none.
const toRuntimeOutcome = <TValue>(
  value: TValue,
  telemetry: WordPressTelemetry
): RuntimeOutcome<TValue> => {
  const { wordpress } = telemetry;

  return wordpress ? { value, wordpress } : { value };
};

// One instance per deployment. It is shared by every caller, so it holds no
// token of its own: each RPC takes the `CallerContext` for that call alone and
// runs the work inside `scope.run`, which the connector tools read back with
// `scope.require()`. Nothing this class writes to storage carries a JWT, an
// email, or a request body — only intents, opaque subjects, the approval
// preview, and the site description.
export class WordPressRuntime extends DurableObject<Env> {
  readonly #scope = createCallerScope();

  #store(): RuntimeStore {
    const { storage } = this.ctx;

    return {
      readPreflight: (executionId) =>
        storage.get<ApplyPreflight>(preflightKey(executionId)),
      readRequester: (executionId) =>
        storage.get<string>(requesterKey(executionId)),
      writePreflight: (executionId, preflight) =>
        storage.put(preflightKey(executionId), preflight),
    };
  }

  #nonces(): NonceStore {
    const { storage } = this.ctx;

    return {
      delete: async (key) => {
        await storage.delete(key);
      },
      read: (key) => storage.get<string>(key),
      write: async (key, digest) => {
        await storage.put(key, digest);
      },
    };
  }

  // The requester, the intent, and the approval preview describe a decision
  // that can still be made. Once the run is terminal there is no decision
  // left, nothing reads them again, and the codemode log keeps the audit
  // trail — so they are deleted here rather than left behind by every run.
  async #forget(executionId: string): Promise<void> {
    await this.ctx.storage.delete(runStorageKeys(executionId));
  }

  // Rebuilt per call rather than cached: the handle is a thin accessor for the
  // durable facet, and the tools it carries close over the caller — and now the
  // telemetry — of this call.
  #runtime(telemetry: WordPressTelemetry) {
    const deps = {
      env: this.env,
      scope: this.#scope,
      store: this.#store(),
      telemetry: () => telemetry,
    };

    const connectors: (PayloadConnector | WordPressConnector)[] = [
      new WordPressConnector(this.ctx, this.env, createWordPressTools(deps)),
    ];

    // A site with Payload gets the `payload` global beside `wp`.
    if (payloadConfigured(this.env)) {
      connectors.push(
        new PayloadConnector(this.ctx, this.env, createPayloadTools(deps))
      );
    }

    return createCodemodeRuntime({
      connectors,
      ctx: this.ctx,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
    });
  }

  #client(caller: CallerContext): WordPressClient {
    return createWordPressClient(this.env, {
      ok: true,
      subjectOpaque: caller.subjectOpaque,
      token: caller.token,
    });
  }

  async #armAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PAUSED_MAX_AGE_MS);
    }
  }

  // The handle has no single-execution read, so one run is found by listing
  // the newest `RECORD_WINDOW` and picking it out. Every RPC reads it once and
  // passes it on, so no path pays for that listing twice.
  async #record(
    executionId: string,
    telemetry: WordPressTelemetry
  ): Promise<ExecutionRecord | undefined> {
    const executions = await this.#runtime(telemetry).executions(RECORD_WINDOW);

    return executions.find((execution) => execution.id === executionId);
  }

  async execute(
    code: string,
    intent: string | undefined,
    caller: CallerContext
  ): Promise<RuntimeOutcome<ExecuteResult>> {
    await this.#armAlarm();
    const telemetry = createWordPressTelemetry();
    const runtime = this.#runtime(telemetry);

    const result = await this.#scope.run(caller, async () => {
      const outcome = await runtime.execute({ code });
      // `requiresApproval` pauses the run before `wp.apply` runs the schema
      // over its own arguments, so an invalid batch would otherwise reach a
      // human as an approval nobody can preview and the model as a pause it
      // cannot act on. Rejecting it here ends the run and returns the
      // validation code instead; nothing about it reaches the approval page.
      const problem = invalidPendingApply(outcome);

      if (!problem) {
        return toExecuteResult(outcome);
      }

      await runtime.reject({
        executionId: outcome.executionId,
        seq: problem.seq,
      });

      return toExecuteResult({
        calls: outcome.calls ?? [],
        error: `${problem.connector}.apply rejected: ${problem.code}: ${problem.message}`,
        executionId: outcome.executionId,
        status: "error",
      });
    });

    // A rejected batch reports `error`, so no run the approval page could
    // read is left with a requester or an intent recorded for it.
    if (result.status === "paused") {
      // The requester is recorded now because the approver replays the write
      // later under their own token: the receipt has to name both.
      // A pause starts with no live token of its own, whatever an earlier one
      // left behind, and one is minted only when a card asks for it.
      await clearRunNonce(this.#nonces(), result.executionId);
      await this.ctx.storage.put(
        requesterKey(result.executionId),
        caller.subjectOpaque
      );

      if (intent) {
        await this.ctx.storage.put(intentKey(result.executionId), intent);
      }
    }

    return toRuntimeOutcome(result, telemetry);
  }

  // The inline approval card's secret for one run. It is minted here and
  // returned once, to the MCP tool result's `_meta` alone; storage keeps only
  // the digest, so nothing persisted can be replayed as an approval.
  issueNonce(executionId: string): Promise<string> {
    return issueRunNonce(this.#nonces(), executionId);
  }

  verifyNonce(executionId: string, nonce: string): Promise<boolean> {
    return verifyRunNonce(this.#nonces(), executionId, nonce);
  }

  consumeNonce(executionId: string, nonce: string): Promise<boolean> {
    return consumeRunNonce(this.#nonces(), executionId, nonce);
  }

  // The replay executes the paused write as the approver: `scope.run` puts the
  // approver's token in reach of `wp.apply`, and the execution id rides along
  // because the resumed call gets none of its own.
  async approve(
    executionId: string,
    caller: CallerContext,
    previewDigest?: string
  ): Promise<RuntimeOutcome<RunReport>> {
    const preflight = await this.#store().readPreflight(executionId);

    const stale = await this.#staleDecision(
      executionId,
      preflight,
      previewDigest
    );

    if (stale) {
      return stale;
    }

    // Any decision retires the run's token, whichever surface made it: the
    // browser page spends none of its own, and without this a run that pauses
    // again would still answer to the token minted for the previous pause.
    await clearRunNonce(this.#nonces(), executionId);
    const telemetry = createWordPressTelemetry();
    const runtime = this.#runtime(telemetry);

    // Which action this decision answers is captured BEFORE the resume:
    // `approve` returns only once the resumed run reaches its next stop, so on
    // a script with a second `wp.apply` the newest entry in the log by then is
    // that second, still-pending write. The report's own `receipt` is the
    // latest apply and is therefore not this decision's; `approvedReceipt` is.
    const approvedSeq = await this.#scope.run(
      preflight
        ? { ...caller, executionId, preflight }
        : { ...caller, executionId },
      async () => {
        const actions = await runtime.pending(executionId);
        const seq = actions.find((action) => isApplyCall(action))?.seq;
        await runtime.approve({ executionId });

        return seq;
      }
    );

    const record = await this.#record(executionId, telemetry);
    const report = await this.#reportAndSweep(executionId, telemetry, record);

    const approvedReceipt =
      record && approvedSeq !== undefined
        ? receiptForSeq(record, approvedSeq)
        : undefined;

    return toRuntimeOutcome(
      approvedReceipt ? { ...report, approvedReceipt } : report,
      telemetry
    );
  }

  // Nothing here reaches WordPress — the runtime marks the run rejected and
  // fires the connectors' disposal hook — but it still runs under the caller,
  // so a connector that ever grows a teardown call has the rejecting user's
  // token and no other.
  async reject(
    executionId: string,
    caller: CallerContext,
    previewDigest?: string
  ): Promise<RuntimeOutcome<RunReport>> {
    const stale = await this.#staleDecision(
      executionId,
      await this.#store().readPreflight(executionId),
      previewDigest
    );

    if (stale) {
      return stale;
    }

    await clearRunNonce(this.#nonces(), executionId);
    const telemetry = createWordPressTelemetry();
    const runtime = this.#runtime(telemetry);
    await this.#scope.run(caller, async () => {
      const actions = await runtime.pending(executionId);
      const seq = actions.at(0)?.seq;

      if (seq !== undefined) {
        await runtime.reject({ executionId, seq });
      }
    });

    return toRuntimeOutcome(
      await this.#reportAndSweep(
        executionId,
        telemetry,
        await this.#record(executionId, telemetry)
      ),
      telemetry
    );
  }

  // The approval page names the preview its form showed. Anything else stored
  // now (the next pause's preview, or one rebuilt for another approver) means
  // the form is answering something its approver never saw, so nothing is
  // decided. The approval card passes no digest: its one-time token is
  // already retired by every decision and minted afresh for each pause.
  async #staleDecision(
    executionId: string,
    preflight: ApplyPreflight | undefined,
    previewDigest: string | undefined
  ): Promise<RuntimeOutcome<RunReport> | undefined> {
    // A page that could show no preview signs the empty digest, which matches
    // a run with none stored: it can still be rejected, and an approval would
    // find no preview and write nothing.
    if (
      previewDigest === undefined ||
      (await preflightDigest(preflight)) === previewDigest
    ) {
      return undefined;
    }

    const telemetry = createWordPressTelemetry();

    const report = await this.#report(
      executionId,
      telemetry,
      await this.#record(executionId, telemetry)
    );

    return toRuntimeOutcome({ ...report, stalePreview: true }, telemetry);
  }

  // A decision either ends the run or pauses it again on the next write. Only
  // a run that actually ended is done with this Worker's own per-run keys: a
  // re-paused run still needs its requester and its intent for the second
  // approval, and `unknown` is not an ending — it is also what a run reports
  // when it fell outside the listing window, whose keys another read may still
  // need. So the sweep names the two terminal statuses and nothing else.
  async #reportAndSweep(
    executionId: string,
    telemetry: WordPressTelemetry,
    record: ExecutionRecord | undefined
  ): Promise<RunReport> {
    const report = await this.#report(executionId, telemetry, record);

    if (report.status === "complete" || report.status === "error") {
      await this.#forget(executionId);
    }

    return report;
  }

  // With a caller — the approval page — this is also where the preview a human
  // approves is computed and stored: `requiresApproval` pauses instead of
  // invoking `wp.apply`, so nothing else can snapshot the posts before the
  // write. Without a caller it reports the stored run and nothing else.
  async getRun(
    executionId: string,
    caller?: CallerContext
  ): Promise<RuntimeOutcome<RunReport>> {
    const telemetry = createWordPressTelemetry();

    return toRuntimeOutcome(
      await this.#report(
        executionId,
        telemetry,
        await this.#record(executionId, telemetry),
        caller
      ),
      telemetry
    );
  }

  async #report(
    executionId: string,
    telemetry: WordPressTelemetry,
    record: ExecutionRecord | undefined,
    caller?: CallerContext
  ): Promise<RunReport> {
    // `pending` stays here: it holds the raw write, and only the preview built
    // from it crosses the RPC boundary.
    const { pending, ...report } = toRunView(
      executionId,
      record,
      await this.ctx.storage.get<string>(intentKey(executionId))
    );

    if (!(caller && report.status === "paused" && pending)) {
      return report;
    }

    try {
      const preflight = await this.#scope.run(caller, () =>
        pending.connector === "payload"
          ? preflightDraftOperations(
              createPayloadClient(this.env, caller),
              pending.intent,
              pending.operations,
              payloadAdminLink(this.env),
              telemetry
            )
          : preflightOperations(
              this.#client(caller),
              pending.intent,
              pending.operations,
              telemetry
            )
      );

      await this.#store().writePreflight(executionId, preflight);

      return { ...report, preflight };
    } catch (error) {
      // A preview that could not be rebuilt retires the one stored before it,
      // so no earlier form can answer a write nobody can now see.
      await this.ctx.storage.delete(preflightKey(executionId));

      return { ...report, preflightError: toRunProblem(error) };
    }
  }

  async describeSite(
    caller: CallerContext
  ): Promise<RuntimeOutcome<SiteDescription>> {
    const telemetry = createWordPressTelemetry();
    // WordPress filters the content types by the caller's capabilities
    // (`context=edit`), so each caller's description is cached apart: an
    // Author's must never stand in for an Editor's, or the reverse.
    const key = `describe:${caller.subjectOpaque}`;
    const cached = await this.ctx.storage.get<CachedDescription>(key);

    // A cache hit made no WordPress request, so it reports none.
    if (cached && isFresh(cached.at, Date.now(), DESCRIBE_TTL_MS)) {
      return toRuntimeOutcome(cached.value, telemetry);
    }

    const value = await this.#scope.run(caller, () =>
      buildSiteDescription(this.#client(caller), telemetry)
    );

    await this.ctx.storage.put(key, { at: Date.now(), value });

    return toRuntimeOutcome(value, telemetry);
  }

  // A run nobody ever answered would otherwise sit paused forever: paused runs
  // are exempt from retention pruning by design.
  async alarm(): Promise<void> {
    // `expirePaused` answers with the ids it actually terminated, so the keys
    // deleted here are exactly those of runs nobody can answer any more.
    const expired = await this.#runtime(
      createWordPressTelemetry()
    ).expirePaused({ maxAgeMs: PAUSED_MAX_AGE_MS });

    await Promise.all(expired.map((id) => this.#forget(id)));
    await this.ctx.storage.setAlarm(Date.now() + PAUSED_MAX_AGE_MS);
  }
}
