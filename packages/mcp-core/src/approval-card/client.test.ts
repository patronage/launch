import type {
  CallToolRequestParams,
  CallToolResult,
  JSONRPCMessage,
  Transport,
} from "@modelcontextprotocol/client";
// @vitest-environment happy-dom
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The card is driven end to end: `client.ts` runs as written, with the real
// MCP Apps `App`, and talks over postMessage to the SDK's own host half,
// `AppBridge`, standing in for the chat client's frame. Each test scripts
// what the host answers to every server tool call the card makes.

type ToolCall = Pick<CallToolRequestParams, "arguments" | "name">;

type Answer = (call: ToolCall) => Promise<CallToolResult>;

interface FakeHost {
  answer: Answer;
  bridge: AppBridge;
  calls: ToolCall[];
  logged: number;
  opened: string[];
  tornDown: number;
}

const META_KEY = "com.patronage/approval";
const POLL_MS = 1500;
const EXECUTION_ID = "run-0001";
const APPROVAL_URL = "https://mcp.example/approve/run-0001";

const refuse: Answer = () => Promise.reject(new Error("no answer scripted"));

// Connects a fresh `AppBridge` to the card's `window.parent`. Every test gets
// its own parent object, so a card loaded by an earlier test ignores this
// one's messages.
const startHost = (): FakeHost => {
  const bridge = new AppBridge(
    null,
    { name: "fake host", version: "1.0.0" },
    { logging: {}, openLinks: {}, serverTools: {} }
  );

  const host: FakeHost = {
    answer: refuse,
    bridge,
    calls: [],
    logged: 0,
    opened: [],
    tornDown: 0,
  };

  // The card's parent stands in for the host's frame: a real message port,
  // so it can be a message's `source`, whose `postMessage` hands what the
  // card posts to the bridge a tick later, as it would arrive across frames.
  const { port1: parent } = new MessageChannel();

  parent.postMessage = (data: JSONRPCMessage) => {
    queueMicrotask(() => transport.onmessage?.(data));
  };

  // The bridge answers by posting into the card's window, from that parent.
  const transport: Transport = {
    close: () => Promise.resolve(),
    send: (message) => {
      window.dispatchEvent(
        new MessageEvent("message", { data: message, source: parent })
      );

      return Promise.resolve();
    },
    start: () => Promise.resolve(),
  };

  bridge.oncalltool = ({ arguments: args, name }) => {
    const call = { arguments: args, name };
    host.calls.push(call);

    return host.answer(call);
  };

  bridge.onopenlink = ({ url }) => {
    host.opened.push(url);

    return Promise.resolve({});
  };

  bridge.onrequestteardown = () => {
    host.tornDown += 1;
  };

  bridge.onloggingmessage = () => {
    host.logged += 1;
  };

  Object.defineProperty(window, "parent", {
    configurable: true,
    value: parent,
  });
  void bridge.connect(transport);

  return host;
};

const pending = (approvalUrl: string = APPROVAL_URL) => ({
  approvalToken: "token-0001",
  approvalUrl,
  executionId: EXECUTION_ID,
  status: "pending",
});

const view = (html: string, canApprove = true) => ({
  canApprove,
  executionId: EXECUTION_ID,
  html,
  summary: "Update the About page title",
});

const paused = (
  html = "<p>Change the About page title</p>",
  canApprove = true,
  approvalUrl?: string
): CallToolResult => ({
  _meta: { [META_KEY]: pending(approvalUrl) },
  content: [],
  structuredContent: view(html, canApprove),
});

const approved = (html: string): CallToolResult => ({
  _meta: {
    [META_KEY]: {
      executionId: EXECUTION_ID,
      status: "approved",
      summary: "The write was approved.",
    },
  },
  content: [],
  structuredContent: view(html, false),
});

const progress = (html: string, running: boolean): CallToolResult => ({
  content: [],
  structuredContent: { ...view(html, false), running },
});

const body = (): HTMLElement => {
  const node = document.querySelector<HTMLElement>("#body");

  if (!node) {
    throw new Error("the card has no #body");
  }

  return node;
};

const button = (decision: "approve" | "reject") =>
  document.querySelector<HTMLButtonElement>(
    `#actions [data-decision="${decision}"]`
  );

const settle = () => vi.advanceTimersByTimeAsync(0);

const callsTo = (host: FakeHost, name: string) =>
  host.calls.filter((call) => call.name === name);

// What resolves a held tool call.
interface Settle {
  resolve?: (result: CallToolResult) => void;
}

// A tool call the test answers by hand, or never.
const held = () => {
  const settler: Settle = {};

  // oxlint-disable-next-line promise/avoid-new -- the test settles it by hand.
  const promise = new Promise<CallToolResult>((resolve) => {
    settler.resolve = resolve;
  });

  return { promise, settler };
};

// A host error with a JSON-RPC code, as the bridge relays it to the card.
const hostError = (code: number, message: string) =>
  Object.assign(new Error(message), { code });

describe("the approval card", () => {
  let host: FakeHost;

  const deliver = async (result: CallToolResult): Promise<void> => {
    await host.bridge.sendToolResult(result);
    await settle();
  };

  beforeEach(async () => {
    // The SDK traces every message it sends and drops at debug level.
    vi.spyOn(console, "debug").mockReturnValue();
    vi.useFakeTimers();
    vi.resetModules();
    document.body.hidden = false;
    document.body.innerHTML =
      '<div id="body">Loading the approval…</div><p id="actions"></p>';
    host = startHost();
    await import("./client");
    await settle();
  });

  afterEach(async () => {
    await host.bridge.close();
    Reflect.deleteProperty(window, "parent");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows a paused write's fragment with both Approve and Deny enabled", async () => {
    await deliver(paused());

    expect(body().innerHTML).toBe("<p>Change the About page title</p>");
    expect(button("approve")).not.toBeNull();
    expect(button("reject")).not.toBeNull();
  });

  it("offers only Deny when the server says the caller cannot approve", async () => {
    await deliver(paused("<p>Change the About page title</p>", false));

    expect(button("approve")).toBeNull();
    expect(button("reject")).not.toBeNull();
  });

  it("fetches the preview when a paused result arrives without a fragment", async () => {
    host.answer = () => Promise.resolve(paused("<p>The preview</p>"));

    await deliver({ _meta: { [META_KEY]: pending() }, content: [] });

    expect(callsTo(host, "preview_write")).toStrictEqual([
      {
        arguments: { approvalToken: "token-0001", executionId: EXECUTION_ID },
        name: "preview_write",
      },
    ]);
    expect(body().innerHTML).toBe("<p>The preview</p>");
    expect(button("approve")).not.toBeNull();
  });

  it("disables both buttons on Approve and says the change is being applied", async () => {
    host.answer = ({ name }) =>
      name === "decide_write"
        ? held().promise
        : Promise.resolve(progress("<p>Saved 1 of 2</p>", true));

    await deliver(paused());
    button("approve")?.click();
    await settle();

    expect(button("approve")).toBeNull();
    expect(button("reject")).toBeNull();
    expect(body().textContent).toBe("Applying the change…");
    expect(callsTo(host, "decide_write")[0]?.arguments).toStrictEqual({
      approvalToken: "token-0001",
      decision: "approve",
      executionId: EXECUTION_ID,
    });
  });

  it("shows the write's progress while the decision is out, and ignores further clicks", async () => {
    host.answer = ({ name }) =>
      name === "decide_write"
        ? held().promise
        : Promise.resolve(progress("<p>Saved 1 of 2</p>", true));

    await deliver(paused());
    button("approve")?.click();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(body().innerHTML).toBe("<p>Saved 1 of 2</p>");

    document.querySelector<HTMLElement>("#actions")?.click();
    await settle();

    expect(callsTo(host, "decide_write")).toHaveLength(1);
  });

  it("stops watching progress once the decision answers with a terminal result", async () => {
    const decision = held();
    host.answer = ({ name }) =>
      name === "decide_write"
        ? decision.promise
        : Promise.resolve(progress("<p>Still saving</p>", true));

    await deliver(paused());
    button("approve")?.click();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    decision.settler.resolve?.(approved("<p>Saved the About page</p>"));
    await settle();

    expect(body().innerHTML).toBe("<p>Saved the About page</p>");

    const looks = callsTo(host, "progress_write").length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);

    expect(callsTo(host, "progress_write")).toHaveLength(looks);
    expect(body().innerHTML).toBe("<p>Saved the About page</p>");
    expect(button("approve")).toBeNull();
  });

  it("follows an approved write to its end when the decision call fails", async () => {
    let looks = 0;
    host.answer = ({ name }) => {
      if (name === "decide_write") {
        return Promise.reject(new Error("Request timed out"));
      }

      looks += 1;

      return Promise.resolve(
        looks < 3
          ? progress(`<p>Saving, look ${looks}</p>`, true)
          : progress("<p>Saved the About page</p>", false)
      );
    };

    await deliver(paused());
    button("approve")?.click();
    await settle();

    expect(body().innerHTML).toBe("<p>Saving, look 1</p>");

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(body().innerHTML).toBe("<p>Saved the About page</p>");

    await vi.advanceTimersByTimeAsync(POLL_MS * 5);

    expect(looks).toBe(3);
  });

  it("shows a host error's code and message when Deny fails", async () => {
    host.answer = () =>
      Promise.reject(hostError(-32_000, "Token already used"));

    await deliver(paused());
    button("reject")?.click();
    await settle();

    expect(body().firstElementChild?.textContent).toBe(
      "This card couldn't send your decision."
    );
    expect(body().querySelector(".reason")?.textContent).toBe(
      "Error -32000: Token already used"
    );
    expect(button("approve")).toBeNull();
    expect(button("reject")).toBeNull();
  });

  it("offers the approval page after a failure and opens it through the host", async () => {
    host.answer = () =>
      Promise.reject(hostError(-32_000, "Token already used"));

    await deliver(paused());
    button("reject")?.click();
    await settle();

    expect(body().querySelector(".link")?.textContent).toBe(APPROVAL_URL);

    body().querySelector("button")?.click();
    await settle();

    expect(host.opened).toStrictEqual([APPROVAL_URL]);
  });

  it("shows an error result's text as the reason, written as text rather than markup", async () => {
    host.answer = () =>
      Promise.resolve({
        content: [{ text: "<b>Refused</b> by policy", type: "text" }],
        isError: true,
      });

    await deliver(paused());
    button("reject")?.click();
    await settle();

    const reason = body().querySelector(".reason");

    expect(reason?.textContent).toBe("<b>Refused</b> by policy");
    expect(reason?.querySelector("b")).toBeNull();
  });

  it("offers no link on failure when the approval page is plain http on a public host", async () => {
    host.answer = () => Promise.reject(new Error("Network down"));

    await deliver(
      paused("<p>Change</p>", true, "http://mcp.example/approve/run-0001")
    );
    button("reject")?.click();
    await settle();

    expect(body().querySelector("button")).toBeNull();
    expect(body().textContent).toContain(
      "Ask for the approval link to answer it instead."
    );
    expect(body().textContent).not.toContain("http://mcp.example");
  });

  it("hides itself and asks the host to remove it for a result with no approval state", async () => {
    await deliver({ content: [{ text: "42 posts", type: "text" }] });

    expect(document.body.hidden).toBeTruthy();
    expect(host.tornDown).toBe(1);
  });
});
