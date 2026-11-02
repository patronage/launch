# @patronage/logging

Logging for Launch's Workers and the provisioning for a site's log store. See [ADR 0016](../../docs/adr/0016-logs-to-r2-through-logpush.md) for the decision and [`docs/spikes/43-logging-logpush.md`](../../docs/spikes/43-logging-logpush.md) for the evidence.

Logging is optional. With nothing configured, each Worker prints one JSON line per request to its console, and nothing else happens. Workers Logs keeps those lines for seven days when the Worker's `cloudflare.config.ts` turns observability on, as Launch's Workers do.

| Export | Use |
| --- | --- |
| `withRequestLog(entry, { service })` | Wrap a Worker's fetch entry (vinext's included) so every request emits one evlog wide event as a JSON console line: method, path without the query, status, duration, `cf-ray`, colo, country and ASN, plus `cache` (vinext's page cache result: `HIT`, `STALE` or `MISS`) and `upstream` totals. Build assets are skipped. Other handlers on the entry are kept. |
| `timeUpstream(name, work)` | Time a call to an upstream and add it to the request's `upstream.<name>` as `{ calls, errors, ms }`. Outside a wrapped request it only runs `work`. |
| `timedD1(binding, name?)` | Wrap a D1 binding so each query counts toward `upstream.d1` (or `name`). |
| `@patronage/logging/cloudflare` | Idempotent Cloudflare API helpers behind the provisioning script: `ensureBucket`, `ensureLogpushJob`, `ensureWordPressStream`, and token helpers. |

## Wide events from a Worker

```ts
// apps/<app>/worker.ts, named as `entrypoint` in cloudflare.config.ts
import { withRequestLog } from "@patronage/logging";
import entry from "vinext/server/fetch-handler";

export * from "vinext/server/fetch-handler";
export default withRequestLog(entry, { service: "web-wordpress" });
```

Pass `sampleRate` (0 to 100) to keep only part of the healthy traffic; responses with status 400 or more, and requests slower than `slowMs` (1000 by default), are always kept.

`upstream` covers the work done before the response starts, which is the same span as `duration`. Reads inside a Suspense boundary that streams later aren't in it; traces show those. web-wordpress times its WPGraphQL and media reads as `upstream.wordpress`, and Payload times its D1 queries as `upstream.d1`.

To keep events past seven days, deploy with `WORKER_LOGPUSH=true`. `cloudflare.config.ts` turns on Workers Trace Events Logpush for the Worker, and the account's `workers_trace_events` job (below) copies every log line to R2. Each evlog event arrives as an entry in the trace event's `Logs` array. For a Worker deployed by Workers Builds, set the variable before running `pnpm run builds:configure`, so builds pass it on.

## Provision the log store

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  pnpm --filter @patronage/logging logging:provision \
  --name demo [--script <worker>]... [--no-account-logs] \
  [--zone <zone id>] [--wordpress] [--dry-run]
```

It creates whatever is missing, by name:

| Resource | Where it writes |
| --- | --- |
| R2 bucket `<name>-logs` |  |
| Logpush job `workers_trace_events` (account) | `logpush/workers_trace_events/{DATE}/` |
| Logpush job `audit_logs_v2` (account) | `logpush/audit_logs_v2/{DATE}/` |
| Logpush job `access_requests` (account) | `logpush/access_requests/{DATE}/` |
| With `--zone`: `http_requests`, `firewall_events` | `logpush/<dataset>/zone=<id>/{DATE}/` |
| With `--wordpress`: Basin stream, sink and pipeline | `events/wordpress/year=/month=/day=/` |

On an account that other sites share, pass each of the site's Workers with `--script` so the `workers_trace_events` job keeps only theirs, and pass `--no-account-logs` to leave out the audit and Access jobs, which cover the whole account.

Logpush files are gzipped NDJSON with every field the dataset has. A job the account's plan does not allow is reported and skipped, and the script exits non-zero so you notice.

The script needs R2 credentials for Logpush and the sink. Pass a pair as `LOGS_R2_ACCESS_KEY_ID` and `LOGS_R2_SECRET_ACCESS_KEY`, or leave them unset and the script creates a token that can write only to that bucket and prints its pair once. With `--wordpress` it also creates a send-only Pipelines token (or reuses `LOGS_PIPELINES_SEND_TOKEN`) and prints the two constants for `wp-config`; see [`wordpress-shared/patronage-logging`](../../wordpress-shared/patronage-logging/README.md).

The API token needs Account Settings Read, Logs Edit (and zone Logs Edit for `--zone`), Workers R2 Storage Edit, Pipelines Edit for `--wordpress`, and API Tokens Edit unless you pass the credentials in.

## Not here

What reads these logs and what it concludes (detection, alerting, dashboards) is not part of Launch.
