import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyPreviewToken } from "./preview-token";

const SECRET = "test-secret";
const NOW = Date.UTC(2026, 0, 1);

/** Signs a token the way the patronage-headless theme does (inc/preview.php). */
const sign = (payload: string, secret = SECRET) =>
  `${Buffer.from(payload).toString("base64url")}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;

const inTenMinutes = Math.floor(NOW / 1000) + 600;

describe(verifyPreviewToken, () => {
  it("returns the post ID for a valid token", async () => {
    await expect(
      verifyPreviewToken(sign(`42.${inTenMinutes}`), SECRET, NOW)
    ).resolves.toBe(42);
  });

  it("rejects an expired token", async () => {
    const expired = sign(`42.${Math.floor(NOW / 1000) - 1}`);

    await expect(verifyPreviewToken(expired, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const forged = sign(`42.${inTenMinutes}`, "another-secret");

    await expect(verifyPreviewToken(forged, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects a payload swapped onto a valid signature", async () => {
    const [, signature] = sign(`42.${inTenMinutes}`).split(".");
    const swapped = `${Buffer.from(`43.${inTenMinutes}`).toString("base64url")}.${signature}`;

    await expect(verifyPreviewToken(swapped, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects malformed tokens and an empty secret", async () => {
    await expect(verifyPreviewToken("", SECRET, NOW)).resolves.toBeNull();
    await expect(
      verifyPreviewToken("not-a-token", SECRET, NOW)
    ).resolves.toBeNull();
    await expect(
      verifyPreviewToken("%%%.%%%", SECRET, NOW)
    ).resolves.toBeNull();
    await expect(
      verifyPreviewToken(sign(`42.${inTenMinutes}`), "", NOW)
    ).resolves.toBeNull();
  });
});
