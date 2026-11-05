import { ApplyConflictError, UpstreamRequestError } from "@patronage/mcp-core";
import type { ReceiptError } from "@patronage/mcp-core";

const MISSED_PATH_LIMIT = 5;

// Receipts never carry an upstream response body, so an unrecognised failure
// collapses to a fixed sentence rather than the thrown message.
export const toReceiptError = <E>(error: E): ReceiptError => {
  if (error instanceof ApplyConflictError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof UpstreamRequestError) {
    return { code: "wordpress_request_failed", message: error.message };
  }

  return { code: "unexpected_error", message: "The operation failed" };
};

// Receipt messages stay bounded: paths only, never values, and never more
// than MISSED_PATH_LIMIT of them.
export const missedPathsMessage = (missed: string[]): string => {
  const listed = missed.slice(0, MISSED_PATH_LIMIT);
  const extra = missed.length - listed.length;
  const suffix = extra > 0 ? ` and ${extra} more` : "";

  return `WordPress did not store ${listed.join(", ")}${suffix}`;
};
