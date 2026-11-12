import { z } from "zod";

import { hashNonce, sameDigest } from "./run";

// The agent feedback channel. An agent that struggles with this MCP — a
// confusing error, a description that sent it the wrong way, a capability it
// needed and could not find — files one structured report with
// `submit_feedback`. The deployment's maintainer (or the maintainer's own
// agent) reads the queue over the Access-protected `/mcp/feedback` routes,
// fixes the tools or their docs, ships, and marks the report resolved with a
// note and the version that carries the fix. The submitting agent sees that
// answer through `get_feedback`, with or without the id it was given.
//
// This module is package-free like `run.ts`: it names no `cloudflare:workers`
// binding, so the whole lifecycle is testable under node vitest against the
// `FeedbackStore` slice of Durable Object storage below.

export const FEEDBACK_ROUTE =
  /^\/mcp\/feedback(?:\/(?<feedbackId>fb_[\w-]{1,64}))?\/?$/u;

export const FEEDBACK_MAINTAINER_HEADER = "X-Feedback-Maintainer-Token";

const KEY_PREFIX = "feedback:";

// Bounds on what the queue may hold. Feedback is agent-written text and can
// quote site content the agent was reading, so it is kept no longer than the
// loop needs: a closed report is deleted 30 days after it closed, the whole
// queue never holds more than `MAX_FEEDBACK`, and one caller cannot hold more
// than `MAX_OPEN_PER_SUBMITTER` unanswered reports at once.
export const MAX_FEEDBACK = 200;
export const MAX_OPEN_PER_SUBMITTER = 20;
export const CLOSED_RETENTION_MS = 30 * 86_400_000;
const MAX_LISTED = 50;

export const feedbackCategories = [
  "bug",
  "confusing_error",
  "docs_gap",
  "missing_capability",
  "unexpected_result",
  "other",
] as const;

export const feedbackTools = [
  "describe_site",
  "execute",
  "get_run",
  "approval",
  "other",
] as const;

export const feedbackStatuses = [
  "open",
  "acknowledged",
  "resolved",
  "wont_fix",
] as const;

export type FeedbackStatus = (typeof feedbackStatuses)[number];

const CLOSED: ReadonlySet<FeedbackStatus> = new Set(["resolved", "wont_fix"]);

export const isClosed = (status: FeedbackStatus): boolean => CLOSED.has(status);

export const submitFeedbackInputSchema = z.object({
  attempted: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe(
      "What you tried: the code, arguments, or sequence of calls, trimmed to what reproduces the problem. Leave out site content and personal data."
    ),
  category: z
    .enum(feedbackCategories)
    .describe(
      "bug: the tool misbehaved. confusing_error: an error did not say how to recover. docs_gap: a description or the docs were missing or wrong. missing_capability: the task needs something no tool offers. unexpected_result: it worked but not as described."
    ),
  details: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe("What happened, including any error code or message verbatim."),
  executionId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe("The execute run this is about, when there is one."),
  expected: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe("What you expected the tool or its documentation to do."),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("One sentence naming the problem."),
  tool: z
    .enum(feedbackTools)
    .describe("The tool or surface the feedback is about."),
});

export type FeedbackSubmission = z.infer<typeof submitFeedbackInputSchema>;

export const feedbackIdSchema = z
  .string()
  .trim()
  .regex(/^fb_[\w-]{1,64}$/u);

export const feedbackUpdateSchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(feedbackStatuses),
  version: z.string().trim().min(1).max(64).optional(),
});

export type FeedbackUpdate = z.infer<typeof feedbackUpdateSchema>;

export const feedbackListFilterSchema = z.object({
  status: z.enum(feedbackStatuses).optional(),
});

export interface FeedbackResolution {
  at: string;
  note?: string;
  version?: string;
}

export interface FeedbackRecord extends FeedbackSubmission {
  id: string;
  resolution?: FeedbackResolution;
  status: FeedbackStatus;
  // Opaque, like every other subject this Worker stores: it lets a caller list
  // their own reports and nothing more.
  submitterOpaque: string;
  submittedAt: string;
  updatedAt: string;
}

// What the submitting agent sees. The submitter is the caller, so naming it
// back adds nothing, and leaving it off keeps a guessed id from revealing who
// filed a report.
export type FeedbackView = Omit<FeedbackRecord, "submitterOpaque">;

export const toFeedbackView = (record: FeedbackRecord): FeedbackView => {
  const { submitterOpaque: _submitter, ...view } = record;

  return view;
};

// The slice of Durable Object storage the queue needs.
export interface FeedbackStore {
  delete: (keys: string[]) => Promise<void>;
  get: (key: string) => Promise<FeedbackRecord | undefined>;
  list: (prefix: string) => Promise<Map<string, FeedbackRecord>>;
  put: (key: string, record: FeedbackRecord) => Promise<void>;
}

export class FeedbackLimitError extends Error {
  constructor() {
    super(
      `You already have ${MAX_OPEN_PER_SUBMITTER} open feedback reports. Call get_feedback to see their status before filing another.`
    );
    this.name = "FeedbackLimitError";
  }
}

export const feedbackKey = (feedbackId: string): string =>
  `${KEY_PREFIX}${feedbackId}`;

export const mintFeedbackId = (): string => `fb_${crypto.randomUUID()}`;

const newestFirst = (left: FeedbackRecord, right: FeedbackRecord): number =>
  right.submittedAt.localeCompare(left.submittedAt);

const allFeedback = async (store: FeedbackStore): Promise<FeedbackRecord[]> => {
  const records = await store.list(KEY_PREFIX);

  return [...records.values()].toSorted(newestFirst);
};

// Makes room for one more report: closed reports go first, oldest first, and
// only a queue that is all open loses its oldest open report.
const overflow = (records: FeedbackRecord[]): string[] => {
  const excess = records.length + 1 - MAX_FEEDBACK;

  if (excess <= 0) {
    return [];
  }

  const oldestFirst = records.toReversed();
  const closed = oldestFirst.filter((record) => isClosed(record.status));
  const open = oldestFirst.filter((record) => !isClosed(record.status));

  return [...closed, ...open]
    .slice(0, excess)
    .map((record) => feedbackKey(record.id));
};

export const submitFeedback = async (
  store: FeedbackStore,
  submission: FeedbackSubmission,
  submitterOpaque: string,
  now: Date = new Date()
): Promise<FeedbackView> => {
  const records = await allFeedback(store);

  const openForSubmitter = records.filter(
    (record) =>
      record.submitterOpaque === submitterOpaque && !isClosed(record.status)
  ).length;

  if (openForSubmitter >= MAX_OPEN_PER_SUBMITTER) {
    throw new FeedbackLimitError();
  }

  const dropped = overflow(records);

  if (dropped.length > 0) {
    await store.delete(dropped);
  }

  const at = now.toISOString();

  const record: FeedbackRecord = {
    ...submission,
    id: mintFeedbackId(),
    status: "open",
    submittedAt: at,
    submitterOpaque,
    updatedAt: at,
  };

  await store.put(feedbackKey(record.id), record);

  return toFeedbackView(record);
};

export const readFeedback = (
  store: FeedbackStore,
  feedbackId: string
): Promise<FeedbackRecord | undefined> => store.get(feedbackKey(feedbackId));

// One report, for the caller who filed it. A report can quote content the
// submitter could read and another caller could not, so a caller asking for
// someone else's id gets the same answer as an id that does not exist.
export const readOwnFeedback = async (
  store: FeedbackStore,
  feedbackId: string,
  submitterOpaque: string
): Promise<FeedbackView | undefined> => {
  const record = await readFeedback(store, feedbackId);

  return record?.submitterOpaque === submitterOpaque
    ? toFeedbackView(record)
    : undefined;
};

// The submitting agent's own reports, newest first: how it learns about a fix
// when it no longer holds the id.
export const listOwnFeedback = async (
  store: FeedbackStore,
  submitterOpaque: string
): Promise<FeedbackView[]> => {
  const records = await allFeedback(store);

  return records
    .filter((record) => record.submitterOpaque === submitterOpaque)
    .slice(0, MAX_LISTED)
    .map(toFeedbackView);
};

// The maintainer's queue. Unfiltered, it is every report not yet closed, oldest
// first, which is the order a maintainer should work them in.
export const listFeedbackQueue = async (
  store: FeedbackStore,
  status?: FeedbackStatus
): Promise<FeedbackRecord[]> => {
  const records = await allFeedback(store);

  return records
    .toReversed()
    .filter((record) =>
      status ? record.status === status : !isClosed(record.status)
    );
};

export const updateFeedback = async (
  store: FeedbackStore,
  feedbackId: string,
  update: FeedbackUpdate,
  now: Date = new Date()
): Promise<FeedbackRecord | undefined> => {
  const current = await readFeedback(store, feedbackId);

  if (!current) {
    return undefined;
  }

  const at = now.toISOString();
  // Every answer replaces the last one. A report moved back to `open` or to
  // `acknowledged` with nothing to say carries no resolution at all, so a
  // reopened report never shows the note of the fix that did not hold.
  const { resolution: _previous, ...rest } = current;

  const next: FeedbackRecord = {
    ...rest,
    status: update.status,
    updatedAt: at,
  };

  if (update.note || update.version || isClosed(update.status)) {
    const resolution: FeedbackResolution = { at };

    if (update.note) {
      resolution.note = update.note;
    }

    if (update.version) {
      resolution.version = update.version;
    }

    next.resolution = resolution;
  }

  await store.put(feedbackKey(feedbackId), next);

  return next;
};

// Run by the Durable Object's daily alarm: closed reports leave the queue
// `CLOSED_RETENTION_MS` after they closed.
export const pruneFeedback = async (
  store: FeedbackStore,
  now: Date = new Date()
): Promise<number> => {
  const cutoff = now.getTime() - CLOSED_RETENTION_MS;
  const records = await allFeedback(store);

  const expired = records
    .filter(
      (record) =>
        isClosed(record.status) && Date.parse(record.updatedAt) < cutoff
    )
    .map((record) => feedbackKey(record.id));

  if (expired.length > 0) {
    await store.delete(expired);
  }

  return expired.length;
};

// The maintainer routes sit behind the same Access application as every other
// route, and additionally require this deployment's maintainer token, because
// Access admits every person who may use the MCP and not every one of them
// should be able to close another caller's report. Both sides are hashed so
// the comparison is over two fixed-length digests and runs in constant time.
export const isMaintainerToken = async (
  configured: string | undefined,
  presented: string | null
): Promise<boolean> => {
  if (!(configured && presented)) {
    return false;
  }

  return sameDigest(await hashNonce(configured), await hashNonce(presented));
};

export const feedbackSummaryText = (view: FeedbackView): string => {
  const resolution = view.resolution?.note ? ` — ${view.resolution.note}` : "";

  const version = view.resolution?.version
    ? ` (shipped in ${view.resolution.version})`
    : "";

  return `Feedback ${view.id}: ${view.status}${resolution}${version}`;
};
