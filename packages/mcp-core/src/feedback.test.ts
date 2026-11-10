import { describe, expect, it } from "vitest";

import {
  CLOSED_RETENTION_MS,
  FEEDBACK_ROUTE,
  FeedbackLimitError,
  feedbackKey,
  isMaintainerToken,
  listFeedbackQueue,
  listOwnFeedback,
  MAX_FEEDBACK,
  MAX_OPEN_PER_SUBMITTER,
  pruneFeedback,
  readFeedback,
  readOwnFeedback,
  submitFeedback,
  updateFeedback,
} from "./feedback";
import type {
  FeedbackRecord,
  FeedbackStore,
  FeedbackSubmission,
} from "./feedback";

const memoryStore = (): FeedbackStore & { size: () => number } => {
  const records = new Map<string, FeedbackRecord>();

  return {
    delete: (keys) => {
      for (const key of keys) {
        records.delete(key);
      }

      return Promise.resolve();
    },
    get: (key) => Promise.resolve(records.get(key)),
    list: (prefix) =>
      Promise.resolve(
        new Map([...records].filter(([key]) => key.startsWith(prefix)))
      ),
    put: (key, record) => {
      records.set(key, record);

      return Promise.resolve();
    },
    size: () => records.size,
  };
};

const report: FeedbackSubmission = {
  category: "docs_gap",
  summary: "The skill does not say how to page through posts",
  tool: "execute",
};

const at = (minutes: number): Date =>
  new Date(Date.UTC(2026, 10, 10, 0, minutes));

describe("feedback queue", () => {
  it("lists the open queue oldest first and leaves closed reports out", async () => {
    const store = memoryStore();
    const first = await submitFeedback(store, report, "agent-a", at(1));
    const second = await submitFeedback(store, report, "agent-b", at(2));
    const third = await submitFeedback(store, report, "agent-a", at(3));
    await updateFeedback(store, second.id, { status: "wont_fix" }, at(4));

    const queue = await listFeedbackQueue(store);
    expect(queue.map((record) => record.id)).toStrictEqual([
      first.id,
      third.id,
    ]);
    const declined = await listFeedbackQueue(store, "wont_fix");
    expect(declined.map((record) => record.id)).toStrictEqual([second.id]);
  });

  it("shows a caller only their own reports, newest first", async () => {
    const store = memoryStore();
    const mine = await submitFeedback(store, report, "agent-a", at(1));
    await submitFeedback(store, report, "agent-b", at(2));
    const newer = await submitFeedback(store, report, "agent-a", at(3));

    const own = await listOwnFeedback(store, "agent-a");
    expect(own.map((view) => view.id)).toStrictEqual([newer.id, mine.id]);
    expect(own[0]).not.toHaveProperty("submitterOpaque");
  });

  it("gives a named report only to the caller who filed it", async () => {
    const store = memoryStore();
    const filed = await submitFeedback(store, report, "agent-a", at(1));

    await expect(
      readOwnFeedback(store, filed.id, "agent-a")
    ).resolves.toMatchObject({ id: filed.id });
    await expect(
      readOwnFeedback(store, filed.id, "agent-b")
    ).resolves.toBeUndefined();
  });

  it("records the maintainer's note and shipped version on resolution", async () => {
    const store = memoryStore();
    const filed = await submitFeedback(store, report, "agent-a", at(1));
    await updateFeedback(
      store,
      filed.id,
      { note: "Documented paging.", status: "resolved", version: "0.3.0" },
      at(5)
    );

    await expect(readFeedback(store, filed.id)).resolves.toMatchObject({
      resolution: {
        at: at(5).toISOString(),
        note: "Documented paging.",
        version: "0.3.0",
      },
      status: "resolved",
      updatedAt: at(5).toISOString(),
    });
  });

  it("drops the old resolution when a report is reopened", async () => {
    const store = memoryStore();
    const filed = await submitFeedback(store, report, "agent-a", at(1));
    await updateFeedback(
      store,
      filed.id,
      { note: "Fixed.", status: "resolved" },
      at(2)
    );

    const reopened = await updateFeedback(
      store,
      filed.id,
      { status: "open" },
      at(3)
    );

    expect(reopened).not.toHaveProperty("resolution");
  });

  it("answers an update to an unknown report with nothing", async () => {
    await expect(
      updateFeedback(memoryStore(), "fb_missing", { status: "resolved" })
    ).resolves.toBeUndefined();
  });

  it("caps how many open reports one caller may hold", async () => {
    const store = memoryStore();
    await Promise.all(
      Array.from({ length: MAX_OPEN_PER_SUBMITTER }, (_, index) =>
        submitFeedback(store, report, "agent-a", at(index))
      )
    );
    await expect(
      submitFeedback(store, report, "agent-a", at(99))
    ).rejects.toBeInstanceOf(FeedbackLimitError);
    await expect(
      submitFeedback(store, report, "agent-b", at(99))
    ).resolves.toMatchObject({ status: "open" });
  });

  it("never holds more than the cap, dropping closed reports first", async () => {
    const store = memoryStore();
    const closed = await submitFeedback(store, report, "agent-0", at(0));
    await updateFeedback(store, closed.id, { status: "resolved" }, at(0));
    await Promise.all(
      Array.from({ length: MAX_FEEDBACK - 1 }, (_, index) =>
        submitFeedback(store, report, `agent-${index + 1}`, at(index + 1))
      )
    );
    expect(store.size()).toBe(MAX_FEEDBACK);

    await submitFeedback(store, report, "agent-new", at(MAX_FEEDBACK + 1));

    expect(store.size()).toBe(MAX_FEEDBACK);
    await expect(store.get(feedbackKey(closed.id))).resolves.toBeUndefined();
  });

  it("prunes closed reports once their retention has passed", async () => {
    const store = memoryStore();
    const old = await submitFeedback(store, report, "agent-a", at(1));
    const open = await submitFeedback(store, report, "agent-a", at(2));
    await updateFeedback(store, old.id, { status: "resolved" }, at(3));

    const later = new Date(at(3).getTime() + CLOSED_RETENTION_MS + 1);
    await expect(pruneFeedback(store, later)).resolves.toBe(1);
    await expect(readFeedback(store, old.id)).resolves.toBeUndefined();
    await expect(readFeedback(store, open.id)).resolves.toBeDefined();
  });
});

describe("feedback maintainer token", () => {
  it("accepts only the configured token", async () => {
    await expect(isMaintainerToken("secret", "secret")).resolves.toBeTruthy();
    await expect(isMaintainerToken("secret", "secreT")).resolves.toBeFalsy();
    await expect(isMaintainerToken("secret", null)).resolves.toBeFalsy();
    await expect(isMaintainerToken(undefined, "secret")).resolves.toBeFalsy();
  });
});

describe("feedback route", () => {
  it("matches the queue and one report, and nothing else", () => {
    expect(FEEDBACK_ROUTE.test("/mcp/feedback")).toBeTruthy();
    expect(
      FEEDBACK_ROUTE.exec("/mcp/feedback/fb_abc-123")?.groups?.feedbackId
    ).toBe("fb_abc-123");
    expect(FEEDBACK_ROUTE.test("/mcp/feedback/../approvals")).toBeFalsy();
    expect(FEEDBACK_ROUTE.test("/mcp")).toBeFalsy();
  });
});
