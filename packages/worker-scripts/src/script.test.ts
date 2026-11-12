import { describe, expect, it } from "vitest";
import { z } from "zod";

import { run, runJson, ScriptError } from "./script.ts";
import { testContext } from "./test-context.ts";
import { readBuiltWorkerConfig, secretNames } from "./worker-config.ts";

describe(run, () => {
  it("names the command, not its JSON arguments, when it fails", () => {
    const ctx = testContext({ status: () => ({ status: 3 }) });

    expect(() =>
      run(ctx, "pnpm", [
        "exec",
        "cf",
        "builds",
        "workers",
        "create",
        "--body",
        "{}",
      ])
    ).toThrow(
      new ScriptError("pnpm exec cf builds workers failed (exit 3).", 3)
    );
  });

  it("reports a command that could not start", () => {
    const ctx = testContext({
      status: () => ({ error: new Error("spawn pnpm ENOENT"), status: null }),
    });

    expect(() => run(ctx, "pnpm", ["run", "build"])).toThrow(
      "Could not run pnpm: spawn pnpm ENOENT"
    );
  });
});

describe(runJson, () => {
  const schema = z.array(z.object({ id: z.string() }));

  it("captures the command's output and parses it", () => {
    const ctx = testContext({
      status: () => ({ status: 0, stdout: '[{"id":"a"}]' }),
    });

    expect(
      runJson(ctx, "Listing", "pnpm", ["exec", "cf"], schema)
    ).toStrictEqual([{ id: "a" }]);
    expect(ctx.spawnCalls[0]?.capture).toBeTruthy();
  });

  it("names the step when the command fails", () => {
    const ctx = testContext({ status: () => ({ status: 2 }) });

    expect(() => runJson(ctx, "Listing", "pnpm", [], schema)).toThrow(
      new ScriptError("Listing failed (exit 2).", 2)
    );
  });

  it("rejects output that is not JSON or not the expected shape", () => {
    const notJson = testContext({
      status: () => ({ status: 0, stdout: "Signed out" }),
    });

    const singleWorker = testContext({
      status: () => ({ status: 0, stdout: '{"id":"a"}' }),
    });

    expect(() => runJson(notJson, "Listing", "pnpm", [], schema)).toThrow(
      "Listing did not return JSON."
    );
    expect(() => runJson(singleWorker, "Listing", "pnpm", [], schema)).toThrow(
      "Listing returned an unexpected result."
    );
  });
});

describe("worker config", () => {
  it("lists only secret bindings", () => {
    expect(
      secretNames({
        env: {
          A: { type: "secret" },
          B: { type: "kv" },
          C: { type: "secret" },
        },
        name: "site",
      })
    ).toStrictEqual(["A", "C"]);
  });

  it("asks for a build when there is no Build Output", () => {
    expect(() => readBuiltWorkerConfig("/nonexistent")).toThrow(
      "Could not read .cloudflare/output/v0/workers/default/worker.config.json. Build the app first."
    );
  });
});
