import { describe, expect, it } from "vitest";

import { wordpressConnector } from "./wp-gateway";

describe("the WordPress connector", () => {
  it("gives a fresh model the complete WordPress call contract", () => {
    const requiredGuidance = [
      "wp.graphql({ query, variables? })",
      "wp.get({ path, query? })",
      "path starts /wp-json/",
      "wp.apply({ intent, operations })",
      'kind: "update_post"',
      "expected_modified_gmt",
      "Put all changes for one post in one operation",
      "Read example:",
      "Write example:",
    ];

    for (const guidance of requiredGuidance) {
      expect(wordpressConnector.executeDescription).toContain(guidance);
    }
  });
});
