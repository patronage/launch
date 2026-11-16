import type { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

// The approval card's pure helpers: which approval links it will offer, and
// how it words a failure. Kept apart from `client.ts`, which starts the card
// as soon as it loads, so they can be tested on their own.

// The longest reason shown in small print, so a verbose host error cannot push
// the approval link out of view.
const MAX_REASON = 200;

// The shape `ontoolresult` is handed, named off the client rather than
// imported from the SDK's internals.
export type ToolAnswer = Parameters<NonNullable<App["ontoolresult"]>>[0];

// Only an https page (or a local one, in development) is offered: the URL came
// from the server, but the card opens nothing it has not checked.
export const safeLink = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

    return url.protocol === "https:" || (local && url.protocol === "http:")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

// What the card reads off a failed call: a JSON-RPC error carries a numeric
// code and a message, and anything else thrown is described by its message
// alone. The host, not this card, decides what it throws, so it is parsed.
export const hostErrorSchema = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
});

export type HostError = z.infer<typeof hostErrorSchema>;

export const parseHostError = (
  parsed: ReturnType<typeof hostErrorSchema.safeParse>
): HostError | undefined => (parsed.success ? parsed.data : undefined);

export const reasonOf = (error: HostError | undefined): string | undefined => {
  const text = error?.message?.trim() ?? "";
  const prefix = error?.code === undefined ? "" : `Error ${error.code}`;
  const reason = [prefix, text].filter(Boolean).join(": ");

  if (!reason) {
    return undefined;
  }

  return reason.length > MAX_REASON
    ? `${reason.slice(0, MAX_REASON)}…`
    : reason;
};

// A tool result that came back as an error, rather than a thrown call: its
// first text block is the reason.
export const resultReason = (result: ToolAnswer): string | undefined => {
  const [first] = Array.isArray(result?.content) ? result.content : [];

  return first?.type === "text" ? reasonOf({ message: first.text }) : undefined;
};
