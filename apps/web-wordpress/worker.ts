// The Worker entry: vinext's own handler, wrapped twice (packages/logging).
// withProbeGuard answers scanner paths such as /.env or /wp-login.php with an
// empty 404 before vinext's router, its not-found page or any WPGraphQL read
// runs. withRequestLog, outside it, emits one evlog wide event per request as a
// JSON console line, marked `probe: true` for a guarded one. Workers Logs keep
// it for seven days; with WORKER_LOGPUSH=true at deploy, Workers Trace Events
// Logpush also copies it to R2. Without that, nothing else changes.
import { withProbeGuard, withRequestLog } from "@patronage/launch-logging";
import entry from "vinext/server/fetch-handler";

export * from "vinext/server/fetch-handler";

export default withRequestLog(withProbeGuard(entry), {
  service: "web-wordpress",
});
