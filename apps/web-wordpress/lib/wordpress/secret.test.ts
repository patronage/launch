import { describe, expect, it } from "vitest";

import { secretMatches } from "./secret";

describe(secretMatches, () => {
  it("accepts the configured secret", async () => {
    await expect(secretMatches("s3cret", "s3cret")).resolves.toBeTruthy();
  });

  it("refuses a different, missing or empty secret", async () => {
    await expect(secretMatches("s3cres", "s3cret")).resolves.toBeFalsy();
    await expect(
      secretMatches("s3cret-and-more", "s3cret")
    ).resolves.toBeFalsy();
    await expect(secretMatches(null, "s3cret")).resolves.toBeFalsy();
    await expect(secretMatches("", "")).resolves.toBeFalsy();
  });
});
