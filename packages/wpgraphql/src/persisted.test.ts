import type { DocumentNode } from "graphql";
import { describe, expect, it } from "vitest";

import { persistedQueryBody, persistedQueryId } from "./persisted.ts";

const HASH = "a".repeat(64);

/** A codegen document: the AST, with the operation's hash in __meta__ when persisted. */
const codegenDocument = (meta?: { hash?: string }): DocumentNode => {
  const document = {
    definitions: [],
    kind: "Document",
    ...(meta && { __meta__: meta }),
  };

  // SAFETY: persistedQueryId reads only __meta__; the AST is never sent.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a stand-in for a codegen document.
  return document as unknown as DocumentNode;
};

describe(persistedQueryId, () => {
  it("reads the codegen hash without its sha256: prefix", () => {
    expect(persistedQueryId(codegenDocument({ hash: `sha256:${HASH}` }))).toBe(
      HASH
    );
  });

  it("accepts a bare hash", () => {
    expect(persistedQueryId(codegenDocument({ hash: HASH }))).toBe(HASH);
  });

  it("throws for a document without __meta__", () => {
    expect(() => persistedQueryId(codegenDocument())).toThrow(TypeError);
  });

  it.each([{}, { hash: "short" }])(
    "throws for a document without a valid hash: %j",
    (meta) => {
      expect(() => persistedQueryId(codegenDocument(meta))).toThrow(TypeError);
    }
  );
});

describe(persistedQueryBody, () => {
  it("sends only the query ID and variables", () => {
    expect(JSON.parse(persistedQueryBody(HASH, '{"uri":"/"}'))).toStrictEqual({
      queryId: HASH,
      variables: { uri: "/" },
    });
  });

  it("defaults to empty variables", () => {
    expect(JSON.parse(persistedQueryBody(HASH))).toStrictEqual({
      queryId: HASH,
      variables: {},
    });
  });
});
