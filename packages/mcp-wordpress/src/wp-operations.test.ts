import { ApplyValidationError } from "@patronage/mcp-core";
import { describe, expect, it } from "vitest";

import {
  changedPaths,
  operationSentence,
  operationTarget,
  parseApplyInput,
} from "./wp-operations";

const operation = {
  fields: { content: "Body", title: "Hello" },
  id: 42,
  kind: "update_post",
  rest_base: "pages",
};

// no-conditional-expect forbids expect() inside a catch block, since an
// assertion that only runs on the (untaken) throwing path silently proves
// nothing. Capturing the thrown value here keeps every expect() below
// unconditional.
const thrownBy = (fn: () => void): Error | undefined => {
  try {
    fn();

    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw error;
  }
};

describe(parseApplyInput, () => {
  it("accepts a batch of update_post operations", () => {
    const parsed = parseApplyInput({
      intent: "Fix the launch page headline",
      operations: [operation],
    });

    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]?.fields?.title).toBe("Hello");
  });

  it("rejects an operation that changes nothing", () => {
    expect(() =>
      parseApplyInput({
        intent: "No-op",
        operations: [{ id: 1, kind: "update_post", rest_base: "pages" }],
      })
    ).toThrow(ApplyValidationError);
  });

  it("rejects an operation whose only field entry is an explicitly undefined value", () => {
    const error = thrownBy(() =>
      parseApplyInput({
        intent: "No real change",
        operations: [
          {
            fields: { title: undefined },
            id: 1,
            kind: "update_post",
            rest_base: "pages",
          },
        ],
      })
    );

    expect(error).toBeInstanceOf(ApplyValidationError);

    if (!(error instanceof ApplyValidationError)) {
      throw new TypeError(
        "expected parseApplyInput to throw ApplyValidationError"
      );
    }

    expect(error.code).toBe("invalid_operations");
  });

  it("still accepts an explicitly undefined field alongside a real change, counting only the real one", () => {
    const parsed = parseApplyInput({
      intent: "Partial update",
      operations: [
        {
          fields: { content: "x", title: undefined },
          id: 1,
          kind: "update_post",
          rest_base: "pages",
        },
      ],
    });

    const [first] = parsed.operations;
    expect(first).toBeDefined();

    if (!first) {
      return;
    }

    expect(changedPaths(first)).toStrictEqual(["content"]);
  });

  it("rejects a batch that addresses the same target twice", () => {
    const error = thrownBy(() =>
      parseApplyInput({
        intent: "Two writes to one page",
        operations: [operation, { ...operation, fields: { title: "Second" } }],
      })
    );

    expect(error).toBeInstanceOf(ApplyValidationError);

    if (!(error instanceof ApplyValidationError)) {
      throw new TypeError(
        "expected parseApplyInput to throw ApplyValidationError"
      );
    }

    expect(error.code).toBe("duplicate_target");
  });

  it("accepts two operations against different targets", () => {
    const parsed = parseApplyInput({
      intent: "Two pages",
      operations: [operation, { ...operation, id: 43 }],
    });

    expect(parsed.operations).toHaveLength(2);
  });

  it("rejects unknown field names and out-of-range batches", () => {
    expect(() =>
      parseApplyInput({
        intent: "Bad field",
        operations: [{ ...operation, fields: { author: "x" } }],
      })
    ).toThrow(ApplyValidationError);
    expect(() => parseApplyInput({ intent: "Empty", operations: [] })).toThrow(
      ApplyValidationError
    );
  });

  it("reports the failing path in the error message", () => {
    const error = thrownBy(() =>
      parseApplyInput({
        intent: "Bad status",
        operations: [{ ...operation, fields: { status: "archived" } }],
      })
    );

    expect(error).toBeInstanceOf(ApplyValidationError);

    if (!(error instanceof ApplyValidationError)) {
      throw new TypeError(
        "expected parseApplyInput to throw ApplyValidationError"
      );
    }

    expect(error.code).toBe("invalid_operations");
    expect(error.message).toContain("operations.0.fields.status");
  });
});

describe("summaries", () => {
  it("names the target and lists the changed paths in a sentence", () => {
    const parsed = parseApplyInput({ intent: "Fix", operations: [operation] });
    const [first] = parsed.operations;
    expect(first).toBeDefined();

    if (!first) {
      return;
    }

    expect(operationTarget(first)).toBe("pages/42");
    expect(changedPaths(first)).toStrictEqual(["title", "content"]);
    expect(operationSentence(first)).toBe(
      "Update title and content on pages 42"
    );
  });

  it("lists acf keys after the core fields, sorted", () => {
    // Deliberately reverse-alphabetical insertion order: ultracite's
    // sort-keys rule forbids writing this as an unsorted object literal, and
    // an already-alphabetical literal couldn't tell a real sort in
    // changedPaths apart from plain insertion-order iteration.
    const acf = Object.fromEntries([
      ["hero_heading", "New"],
      ["banner_text", "Also"],
    ] as const);

    const parsed = parseApplyInput({
      intent: "Fix",
      operations: [
        {
          acf,
          fields: { title: "Hello" },
          id: 12,
          kind: "update_post",
          rest_base: "pages",
        },
      ],
    });

    const [first] = parsed.operations;
    expect(first).toBeDefined();

    if (!first) {
      return;
    }

    expect(changedPaths(first)).toStrictEqual([
      "title",
      "acf.banner_text",
      "acf.hero_heading",
    ]);
    expect(operationSentence(first)).toBe(
      "Update title, acf.banner_text and acf.hero_heading on pages 12"
    );
  });
});
