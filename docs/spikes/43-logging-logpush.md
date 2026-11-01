# Spike: wide-event logging and Logpush to R2

Decision: [ADR 0016](../adr/0016-logs-to-r2-through-logpush.md). Code: [`packages/logging`](../../packages/logging/README.md) and [`wordpress-shared/patronage-logging`](../../wordpress-shared/patronage-logging/README.md).

## Question

Can every Reference site keep its logs in one store it owns, long enough for an agent to watch them, using only Cloudflare and with nothing to run when logging is off?

## Answer

Yes. Workers need nothing beyond a JSON console line per request and Workers Trace Events Logpush. Cloudflare's account and zone logs go to the same R2 bucket through Logpush jobs. WordPress on a host without Logpush sends its events to a Basin Pipelines stream that writes into the same bucket.

**Recommendation:** wrap each Worker's entry with `withRequestLog`, provision a site's bucket and jobs with `logging:provision`, and turn the WordPress mu-plugin on only where a site wants its CMS events kept.

## What was tested

| Check | Result |
| --- | --- |
| `vite build` of `apps/web-wordpress` and `apps/payload` with their entries wrapped by `withRequestLog` | Pass |
| `vite preview`, requests to a page and an API route | One wide event per request with `service`, `method`, `path` (no query), `status`, `durationMs`, `requestId`, `colo`, `country`, `asn` |
| Requests for `/_next/static/*` | No event |
| `cloudflare.config.ts` accepts `logpush` | Yes; `cf` sends it with the Worker upload |
| Provisioning helpers against a fake API | Bucket, Logpush jobs (account and zone), Basin stream, sink and pipeline created once, then left alone; dry run sends no writes |
| WordPress plugin loaded with nothing configured | Registers no hooks |
| WordPress spool and shipper | Events spooled with an exit guard, sent in batches, kept after a failed send; log files resume from their offset and restart after rotation |

## Findings

- **No binding is needed on Workers.** evlog prints each wide event as a structured console line, which Workers Logs index and Workers Trace Events Logpush copies to R2. The cost is that the event is nested in the trace event's `Logs` array as a string, so the query side unpacks it. Basin would give real columns, but it adds a binding and a token to every Worker, and logging would stop being free to leave on.
- **vinext's entry can be wrapped.** Pointing `entrypoint` at a local `worker.ts` that imports `vinext/server/fetch-handler` and re-exports it keeps vinext's virtual worker entry and build output unchanged.
- **Access logs need Logpush.** The Free Zero Trust plan keeps them only 24 hours in the dashboard. Pipelines' own Logpush source does not list the Zero Trust datasets, so they go to R2 as Logpush files like the rest.
- **Audit logs are kept 18 months by Cloudflare** and queryable through the API. Logpush copies them for one store, not for retention.
- **Logpush to R2 needs S3 credentials.** An account-owned API token scoped to one bucket's object writes gives them: the token id is the access key id and the SHA-256 of its value is the secret.
- **Cloudways gives no root**, so no log agent like Vector. A server cron running `wp patronage-logging ship` reads the app's log files and the plugin's spool and posts them over HTTPS.
- **Per-dataset plan limits are not documented.** Logpush itself is on every plan and Workers Trace Events needs Workers Paid. Zone `http_requests` has historically been Enterprise-only; the script tries each job and reports what the plan refused.

## Not done here

- A read-only `logs` connector in the MCP gateway, so an agent can query the bucket.
- Anything that reads the logs and decides what they mean.
