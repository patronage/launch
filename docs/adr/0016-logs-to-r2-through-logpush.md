# ADR 0016: Each site's logs go to its own R2 bucket, through Logpush where it can

## Status

Accepted, 2026-10-31. Takes up the usage-reporting future work in [ADR 0014](0014-mcp-gateway-worker.md). Corrected 2026-11-09 to describe the MCP gateway's logger.

## Context

A Reference site's activity is spread across its Workers (Front-end, Payload, MCP gateway), its Cloudflare account (dashboard and API changes, Access sign-ins, edge traffic) and, for WordPress, a host outside Cloudflare. Workers Logs keep seven days. A monitoring agent, or a weekly usage report, needs the logs kept longer and in one place the site owns.

Launch is public and ships the plumbing. What reads the logs and what it concludes (detection rules, alerting, dashboards) is a separate product and stays out of this repo. Logging is optional: many sites built on Launch will not turn it on.

## Decision

- **One R2 bucket per site** holds every log, under `logpush/<dataset>/` for Cloudflare's logs and `events/<source>/` for events sent in.
- **Workers use Logpush only.** Each Worker emits one evlog wide event per request as a JSON console line: the Front-ends and Payload through `@patronage/logging`'s `withRequestLog`, and the MCP gateway through `@patronage/mcp-core`'s own `withMcpRequestLog`, which adds the MCP fields. Workers Trace Events Logpush, switched on with `WORKER_LOGPUSH=true` at deploy, copies those lines to R2. Workers get no logging binding, no drain and no Basin. mcp-core's `createWorker` accepts an optional evlog `drain`, which its tests use to read events; Launch's gateway does not set one, and a site following this decision should not either.
- **Cloudflare's own logs use Logpush jobs** into the same bucket: `workers_trace_events`, `audit_logs_v2` and `access_requests` for the account, and `http_requests` and `firewall_events` per zone where the plan allows.
- **WordPress on a host without Logpush uses Basin Pipelines.** The `patronage-logging` mu-plugin spools security events and, optionally, the host's log files, and a cron sends them to an authenticated Basin stream with a send-only token. The stream's sink writes gzipped JSON into the same bucket.
- **Off unless configured.** With no Logpush job, no `WORKER_LOGPUSH` and no logging constants, every piece is a no-op apart from the console line Workers Logs already keep. Tests cover the unconfigured path.
- **Provisioned by script**, `packages/logging/scripts/provision-logging.ts`, through the Cloudflare API and idempotent by name ([ADR 0003](0003-cloudflare-config-through-cf-cli.md)).

## Consequences

- An evlog event reaches R2 as a string inside a Workers trace event's `Logs` array, so whatever queries the bucket unpacks it. That is the cost of using no binding.
- Logpush cannot backfill and drops logs while a job is failing. Watching for gaps belongs to the monitoring product, not to Launch.
- Which datasets a site gets depends on its Cloudflare plan; the script skips and reports the rest.
- The events carry client IPs and the usernames tried at login, because they are security records; a username that is an email address is stored as a short hash. They carry no request bodies, query strings, cookies, passwords, content or email addresses.
- Collectors for sources outside the CMS and Cloudflare (third-party audit APIs, jump hosts) are out of scope.
- A read-only `logs` connector for the MCP gateway is the next step, and the weekly usage report becomes a query over the same bucket.
