import { describe, expect, it } from "vitest";

import type { ConnectorToolMap } from "./connector";
import {
  ApprovalReplayReadError,
  canonicalArgs,
  guardApprovalReplay,
} from "./replay-guard";

const schema = { type: "object" } as const;

const tools = (calls: string[]): ConnectorToolMap => ({
  apply: {
    description: "write",
    execute: () => {
      calls.push("apply");

      return Promise.resolve("applied");
    },
    inputSchema: schema,
    requiresApproval: true,
  },
  get: {
    description: "read",
    execute: () => {
      calls.push("get");

      return Promise.resolve("read");
    },
    inputSchema: schema,
  },
});

describe(guardApprovalReplay, () => {
  it("runs every tool outside an approval", async () => {
    const calls: string[] = [];
    const guarded = guardApprovalReplay(tools(calls), () => false);

    await expect(guarded.get?.execute({})).resolves.toBe("read");
    await expect(guarded.apply?.execute({})).resolves.toBe("applied");
    expect(calls).toStrictEqual(["get", "apply"]);
  });

  it("refuses reads, and only reads, while an approval resumes", async () => {
    const calls: string[] = [];
    const guarded = guardApprovalReplay(tools(calls), () => true);

    await expect(guarded.get?.execute({})).rejects.toBeInstanceOf(
      ApprovalReplayReadError
    );
    await expect(guarded.apply?.execute({})).resolves.toBe("applied");
    expect(calls).toStrictEqual(["apply"]);
  });
});

describe(canonicalArgs, () => {
  it("ignores key order and drops undefined members like JSON", () => {
    const reordered = JSON.parse('{"b":{"d":[1,"x"],"c":null},"a":1}');

    expect(canonicalArgs({ a: 1, b: { c: null, d: [1, "x"] } })).toBe(
      canonicalArgs(reordered)
    );
    expect(canonicalArgs({ a: 1 })).toBe(canonicalArgs({ a: 1, e: undefined }));
  });

  it("matches the arguments after the durable log's JSON round trip", () => {
    const args = {
      intent: "t",
      operations: [{ fields: { a: [1, undefined] }, id: 3 }],
    };

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- the log stores JSON, which is the point of the test.
    expect(canonicalArgs(JSON.parse(JSON.stringify(args)))).toBe(
      canonicalArgs(args)
    );
  });

  it("tells changed values and extra keys apart", () => {
    expect(canonicalArgs({ title: "a" })).not.toBe(
      canonicalArgs({ title: "b" })
    );
    expect(canonicalArgs({ title: "a" })).not.toBe(
      canonicalArgs({ extra: 1, title: "a" })
    );
  });

  it("refuses values JSON cannot serialise", () => {
    const cyclic = { self: {} };
    cyclic.self = cyclic;

    expect(canonicalArgs(cyclic)).toBeUndefined();
    expect(canonicalArgs({ big: 1n })).toBeUndefined();
    expect(canonicalArgs(undefined)).toBeUndefined();
  });
});
