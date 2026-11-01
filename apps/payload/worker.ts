// The Worker entry: vinext's own handler, wrapped so every request emits one
// evlog wide event as a JSON console line (packages/logging). Workers Logs keep
// it for seven days; with WORKER_LOGPUSH=true at deploy, Workers Trace Events
// Logpush also copies it to R2. Without that, nothing else changes.
import { withRequestLog } from "@patronage/logging";
import entry from "vinext/server/fetch-handler";

export * from "vinext/server/fetch-handler";

export default withRequestLog(entry, { service: "payload" });
