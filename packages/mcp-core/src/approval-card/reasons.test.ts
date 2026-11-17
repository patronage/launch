import { describe, expect, it } from "vitest";

import {
  hostErrorSchema,
  parseHostError,
  reasonOf,
  resultReason,
  safeLink,
} from "./reasons";
import type { HostError } from "./reasons";

describe(safeLink, () => {
  it("offers an https approval page as it was given", () => {
    expect(safeLink("https://mcp.example/approve/run-1?t=abc")).toBe(
      "https://mcp.example/approve/run-1?t=abc"
    );
  });

  it("offers an http page only on localhost or 127.0.0.1", () => {
    expect(safeLink("http://localhost:8787/approve/run-1")).toBe(
      "http://localhost:8787/approve/run-1"
    );
    expect(safeLink("http://127.0.0.1:8787/approve/run-1")).toBe(
      "http://127.0.0.1:8787/approve/run-1"
    );
    expect(safeLink("http://example.com/approve/run-1")).toBeUndefined();
  });

  it("refuses javascript: and data: URLs", () => {
    // oxlint-disable-next-line no-script-url -- the card must refuse it.
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    // oxlint-disable-next-line no-script-url -- the card must refuse it.
    expect(safeLink("JavaScript:alert(1)")).toBeUndefined();
    expect(
      safeLink("data:text/html,<script>alert(1)</script>")
    ).toBeUndefined();
  });

  it("refuses a malformed, relative or missing URL", () => {
    expect(safeLink("https://")).toBeUndefined();
    expect(safeLink("not a url")).toBeUndefined();
    expect(safeLink("/approve/run-1")).toBeUndefined();
    expect(safeLink("")).toBeUndefined();
    expect(safeLink(undefined)).toBeUndefined();
  });

  it("refuses a localhost lookalike served over http", () => {
    expect(safeLink("http://localhost.example.com/approve")).toBeUndefined();
  });
});

// What a failed host call may throw: a JSON-RPC error, an Error, or anything.
type Thrown = Error | HostError | string | undefined | { code: string };

// What the card shows for a value a failed host call threw.
const reasonFor = (thrown: Thrown) =>
  reasonOf(parseHostError(hostErrorSchema.safeParse(thrown)));

describe("parseHostError and reasonOf", () => {
  it("names a JSON-RPC error by its code and message", () => {
    expect(reasonFor({ code: -32_603, message: " Internal error " })).toBe(
      "Error -32603: Internal error"
    );
  });

  it("describes a thrown Error by its message alone", () => {
    expect(reasonFor(new Error("Request timed out"))).toBe("Request timed out");
  });

  it("gives no reason for a thrown value it cannot read", () => {
    expect(reasonFor("a bare string")).toBeUndefined();
    expect(reasonFor({ code: "E_FAIL" })).toBeUndefined();
    expect(reasonFor({ message: "   " })).toBeUndefined();
    expect(reasonFor(undefined)).toBeUndefined();
  });

  it("shows a code without a message as the code alone", () => {
    expect(reasonFor({ code: 403 })).toBe("Error 403");
  });

  it("cuts a long reason to 200 characters and marks the cut", () => {
    const reason = reasonOf({ message: "x".repeat(500) });

    expect(reason).toBe(`${"x".repeat(200)}…`);
  });
});

describe(resultReason, () => {
  it("reads the reason from an error result's first text block", () => {
    expect(
      resultReason({
        content: [
          { text: "Unknown tool: decide_write", type: "text" },
          { text: "ignored", type: "text" },
        ],
        isError: true,
      })
    ).toBe("Unknown tool: decide_write");
  });

  it("gives no reason when the first block is not text, or there is none", () => {
    expect(
      resultReason({
        content: [{ data: "AAAA", mimeType: "image/png", type: "image" }],
        isError: true,
      })
    ).toBeUndefined();
    expect(resultReason({ content: [], isError: true })).toBeUndefined();
  });
});
