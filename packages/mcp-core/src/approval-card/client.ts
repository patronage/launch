import { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

import { delay } from "../concurrency";

// The browser half of the inline approval card. It runs in the host's app
// frame, not in the Worker, so it is compiled apart from the rest of `src`
// (see the tsconfig beside this file) and bundled by
// `scripts/build-approval-card.mjs` into a string the card HTML inlines.
//
// It renders nothing of its own: every fragment it shows was rendered and
// escaped by `approval-page.ts`, and its own sentences are written as text
// rather than as markup. It fetches nothing and loads nothing — the resource's
// declared CSP allows no origin at all.
const META_KEY = "com.patronage/approval";
const DECIDE_TOOL = "decide_write";
const PREVIEW_TOOL = "preview_write";

const PROGRESS_TOOL = "progress_write";

// How often the card asks how an approved write is going.
const PROGRESS_POLL_MS = 1500;

const APPROVE_BUTTON =
  '<button class="approve" data-decision="approve" type="button">Approve</button>';

const DENY_BUTTON =
  '<button class="reject" data-decision="reject" type="button">Deny</button>';

const LOADING = "Loading the change to approve…";

const UNREACHABLE =
  "The approval card could not reach the server. Use the approval link instead.";

const UNSTARTED =
  "This approval card could not start. Use the approval link instead.";

// The two halves of what a paused tool result hands this card: the state in
// `_meta`, which carries the one-time approval token, and the server-rendered
// fragment in `structuredContent`. Both are parsed rather than trusted.
const pendingApprovalSchema = z.object({
  approvalToken: z.string(),
  executionId: z.string(),
  status: z.literal("pending"),
});

const endedApprovalSchema = z.object({
  executionId: z.string(),
  status: z.enum(["approved", "denied", "error"]),
  summary: z.string(),
});

const approvalStateSchema = z.union([
  pendingApprovalSchema,
  endedApprovalSchema,
]);

const cardViewSchema = z.object({
  canApprove: z.boolean(),
  executionId: z.string(),
  html: z.string(),
  summary: z.string(),
});

const progressViewSchema = cardViewSchema.extend({ running: z.boolean() });

type PendingApproval = z.infer<typeof pendingApprovalSchema>;

// The shape `ontoolresult` is handed, named off the client rather than
// imported from the SDK's internals.
type ToolAnswer = Parameters<NonNullable<App["ontoolresult"]>>[0];

const app = new App(
  { name: "launch-mcp approval", version: "1.0.0" },
  { tools: {} }
);

const body = document.querySelector("#body");
const actions = document.querySelector("#actions");

let run: PendingApproval | undefined;
let busy = false;

const say = (text: string): void => {
  if (body) {
    body.textContent = text;
  }
};

const setActions = (canApprove: boolean, canDeny: boolean): void => {
  if (actions) {
    actions.innerHTML = `${canApprove ? APPROVE_BUTTON : ""}${canDeny ? DENY_BUTTON : ""}`;
  }
};

// An `execute` result with no approval state is a read, a failure, or a run
// somebody else already answered: the card asks the host to remove it rather
// than leave an empty panel in the conversation.
const teardown = async (): Promise<void> => {
  document.body.hidden = true;

  try {
    await app.requestTeardown();
  } catch {
    // A host that does not support teardown leaves the hidden card in place.
  }
};

const decisionArguments = (
  pending: PendingApproval,
  decision?: "approve" | "reject"
) =>
  decision
    ? {
        approvalToken: pending.approvalToken,
        decision,
        executionId: pending.executionId,
      }
    : {
        approvalToken: pending.approvalToken,
        executionId: pending.executionId,
      };

// One entry point for every answer the card receives, whether it arrived as
// the host's tool-result notification or as the return of a call this card
// made. It answers whether the preview still has to be fetched — a paused
// state that came without a fragment — rather than fetching it itself, so the
// card has one direction of control flow and no mutual recursion.
const render = (result: ToolAnswer): boolean => {
  busy = false;
  const state = approvalStateSchema.safeParse(result?._meta?.[META_KEY]);

  if (!state.success) {
    void teardown();

    return false;
  }

  const view = cardViewSchema.safeParse(result?.structuredContent);

  if (state.data.status === "pending") {
    run = state.data;

    if (view.success && body) {
      body.innerHTML = view.data.html;
      setActions(view.data.canApprove, true);

      return false;
    }

    setActions(false, false);
    say(LOADING);

    return true;
  }

  run = undefined;
  setActions(false, false);

  if (view.success && body) {
    body.innerHTML = view.data.html;

    return false;
  }

  say(state.data.summary);

  return false;
};

const call = async (
  name: string,
  decision?: "approve" | "reject"
): Promise<void> => {
  const pending = run;

  if (!pending) {
    return;
  }

  busy = true;

  try {
    const answer = await app.callServerTool({
      arguments: decisionArguments(pending, decision),
      name,
    });

    // A decision that re-pauses the run comes back as a new pending state with
    // its own fragment, so only a state with no fragment asks for one.
    if (render(answer)) {
      await call(PREVIEW_TOOL);
    }
  } catch {
    busy = false;
    setActions(false, false);
    say(UNREACHABLE);
  }
};

// One look at an approved write: its progress, or its ending once it has one.
// Answers whether the write is still running. A failed look is not an ending:
// the next one tries again.
const showProgress = async (executionId: string): Promise<boolean> => {
  try {
    const answer = await app.callServerTool({
      arguments: { executionId },
      name: PROGRESS_TOOL,
    });

    const view = progressViewSchema.safeParse(answer?.structuredContent);

    if (!view.success) {
      return true;
    }

    if (body) {
      body.innerHTML = view.data.html;
    }

    return view.data.running;
  } catch {
    return true;
  }
};

// Polls while `active` says the decision call is still out. Progress is shown
// only while the decision is unanswered; the decision's own answer replaces
// it the moment it arrives.
const watchWhile = async (
  executionId: string,
  active: () => boolean
): Promise<void> => {
  await delay(PROGRESS_POLL_MS);

  if (!active()) {
    return;
  }

  await showProgress(executionId);
  await watchWhile(executionId, active);
};

// After a decision call that never answered (a host that gave up on a long
// tool call), the write may still be running on the server: keep showing its
// progress until it ends, then its ending.
const followToEnd = async (executionId: string): Promise<void> => {
  if (await showProgress(executionId)) {
    await delay(PROGRESS_POLL_MS);
    await followToEnd(executionId);
  }
};

const approve = async (pending: PendingApproval): Promise<void> => {
  busy = true;
  let answered = false;
  void watchWhile(pending.executionId, () => !answered);

  try {
    const answer = await app.callServerTool({
      arguments: decisionArguments(pending, "approve"),
      name: DECIDE_TOOL,
    });

    answered = true;

    if (render(answer)) {
      await call(PREVIEW_TOOL);
    }
  } catch {
    answered = true;
    run = undefined;
    setActions(false, false);
    await followToEnd(pending.executionId);
    busy = false;
  }
};

actions?.addEventListener("click", (event) => {
  const { target } = event;

  const decision =
    target instanceof HTMLElement ? target.dataset.decision : undefined;

  if (busy || !run) {
    return;
  }

  if (decision === "approve" || decision === "reject") {
    setActions(false, false);
    say(
      decision === "approve" ? "Applying the change…" : "Denying the change…"
    );

    if (decision === "approve" && run) {
      void approve(run);
    } else {
      void call(DECIDE_TOOL, decision);
    }
  }
});

app.ontoolresult = (result) => {
  if (render(result)) {
    void call(PREVIEW_TOOL);
  }
};

const start = async (): Promise<void> => {
  try {
    await app.connect();
  } catch {
    say(UNSTARTED);
  }
};

void start();
