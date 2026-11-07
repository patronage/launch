import type { ConnectorToolDefinition, ConnectorToolMap } from "./connector";

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- a JSON.stringify replacer sees every value the serialiser walks, before any schema has run. */
type JsonReplacerValue =
  | { [key: string]: JsonReplacerValue }
  | JsonReplacerValue[]
  | string
  | number
  | boolean
  | null
  | undefined;

// An approval resumes a paused run by running its script again from the top:
// calls already in the durable log answer from the log, and everything from
// the paused write onwards runs live under the APPROVER's token, because that
// is the token the write must run as. A read that runs live in that pass would
// therefore read as the approver, on behalf of a script the requester wrote and
// the approver never saw past the write. So in the approval pass only writes
// that need approval run; every other tool refuses. Reads a script made before
// it paused are unaffected: they come back from the log and never reach a tool.
export class ApprovalReplayReadError extends Error {
  constructor(tool: string) {
    super(
      `${tool} cannot run after an approved write: the rest of the script would read as the approver. Read before writing, or start a new execute run to read the result.`
    );
    this.name = "ApprovalReplayReadError";
  }
}

const guarded = (
  name: string,
  tool: ConnectorToolDefinition,
  inApprovalReplay: () => boolean
): ConnectorToolDefinition => ({
  ...tool,
  execute: (args, ctx) => {
    if (inApprovalReplay()) {
      return Promise.reject(new ApprovalReplayReadError(name));
    }

    return tool.execute(args, ctx);
  },
});

// `inApprovalReplay` answers whether the call is running inside an approval's
// resume: the runtime sets an execution id on the caller there and nowhere
// else.
export const guardApprovalReplay = (
  tools: ConnectorToolMap,
  inApprovalReplay: () => boolean
): ConnectorToolMap =>
  Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      tool.requiresApproval ? tool : guarded(name, tool, inApprovalReplay),
    ])
  );

// The approval resume compares a write's arguments with the ones recorded when
// the run paused, but @cloudflare/codemode 0.5.1 skips that comparison when
// either side cannot be serialised (a cyclic object, say), and the apply
// schemas strip keys they do not know. So the gateway makes its own check on
// the JSON form, which is what the durable log recorded and what the
// approver's preview was built from. The write then runs on that JSON form,
// not on the live object, so nothing a `toJSON` or a getter hides from the
// comparison can reach the CMS.
const sortKeys = (_key: string, value: JsonReplacerValue): JsonReplacerValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .map((key) => [key, value[key]])
      )
    : value;

// Sorted-key JSON, or `undefined` when the value cannot be serialised.
export const canonicalArgs = <T>(value: T): string | undefined => {
  try {
    return JSON.stringify(value, sortKeys);
  } catch {
    return undefined;
  }
};
