import { describe, expect, it } from "vitest";

import { computeGatewayProof, verifyGatewayProof } from "./gateway-proof.ts";

// Known-answer vector shared verbatim with
// wordpress-shared/patronage-access/tests/verify.test.php, so the two
// implementations cannot drift.
const SECRET = "proof-test-secret";
const JWT = "aaa.bbb.ccc";
const NOW = 1_700_000_000;

const KNOWN =
  "t=1700000000,v1=1c8f01bed0503f0d5e251595bb5d22c4139dbf1db58b43f63c5d8463d26aa227";

describe("gateway proof", () => {
  it("matches the shared known-answer vector", async () => {
    await expect(computeGatewayProof(SECRET, JWT, NOW)).resolves.toBe(KNOWN);
    await expect(
      verifyGatewayProof(KNOWN, JWT, SECRET, NOW)
    ).resolves.not.toBeTypeOf("string");
  });

  it("enforces the 300 second skew both ways", async () => {
    await expect(
      verifyGatewayProof(KNOWN, JWT, SECRET, NOW + 300)
    ).resolves.not.toBeTypeOf("string");
    await expect(
      verifyGatewayProof(KNOWN, JWT, SECRET, NOW + 301)
    ).resolves.toBe("stale_proof");
    await expect(
      verifyGatewayProof(KNOWN, JWT, SECRET, NOW - 301)
    ).resolves.toBe("stale_proof");
  });

  it("binds the proof to one token and one secret", async () => {
    await expect(
      verifyGatewayProof(KNOWN, "other.jwt.value", SECRET, NOW)
    ).resolves.toBe("proof_signature");
    await expect(
      verifyGatewayProof(KNOWN, JWT, "wrong-secret", NOW)
    ).resolves.toBe("proof_signature");
  });

  it.each([
    "",
    "t=1700000000",
    "t=1700000000,v1=SHORT",
    KNOWN.toUpperCase(),
    KNOWN.replace("t=1700000000", "t=-1"),
  ])("rejects malformed proof %#", async (proof) => {
    await expect(verifyGatewayProof(proof, JWT, SECRET, NOW)).resolves.toBe(
      "malformed_proof"
    );
  });
});
