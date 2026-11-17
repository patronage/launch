import { describe, expect, it } from "vitest";

import { DEFAULT_LOCK_SECONDS, heldByAnother } from "./document-lock";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

const check = { now: NOW, seconds: DEFAULT_LOCK_SECONDS, userId: 1 };

const lockAt = (secondsAgo: number, holder: number) => ({
  updatedAt: new Date(NOW - secondsAgo * 1000).toISOString(),
  user: { relationTo: "users", value: holder },
});

describe(heldByAnother, () => {
  it("holds while another editor's lock is fresh", () => {
    expect(heldByAnother(lockAt(10, 2), check)).toBeTruthy();
    expect(heldByAnother(lockAt(DEFAULT_LOCK_SECONDS, 2), check)).toBeTruthy();
  });

  it("lets go once the lock has run out", () => {
    expect(
      heldByAnother(lockAt(DEFAULT_LOCK_SECONDS + 1, 2), check)
    ).toBeFalsy();
  });

  it("uses the document's own lock duration", () => {
    expect(heldByAnother(lockAt(45, 2), { ...check, seconds: 30 })).toBeFalsy();
    expect(
      heldByAnother(lockAt(45, 2), { ...check, seconds: 60 })
    ).toBeTruthy();
  });

  it("does not stop the editor who holds the lock", () => {
    expect(heldByAnother(lockAt(10, 1), check)).toBeFalsy();
  });

  it("holds a lock with no editor or no readable time", () => {
    expect(
      heldByAnother({ updatedAt: "not a date", user: null }, check)
    ).toBeTruthy();
    expect(
      heldByAnother(lockAt(10, 2), { ...check, userId: undefined })
    ).toBeTruthy();
  });
});
