# ADR 0005: vinext front-ends on Cloudflare Workers

## Status

Accepted, 2026-10-29.

## Context

The Front-ends should run on Cloudflare Workers next to Access, keep the Next.js App Router model that Patronage's sites already use, and cache pages at the edge.

## Decision

- Every Front-end is a vinext app on Workers. The baseline is vinext 1.4.x.
- Front-ends that read a remote CMS (headless WordPress) cache pages and data with vinext's KV data adapter. Dynamic routes export `revalidate` and `generateStaticParams` (which may return `[]`) to get ISR.
- The Payload Front-end reads in-process through the Local API and renders dynamically, with no KV cache for now.
- The headless WordPress Front-end reads WPGraphQL only. There is no WordPress REST Front-end.
- TanStack Start may be evaluated later for Payload; until then, vinext is the only Front-end framework.

## Consequences

- vinext is young. Workarounds are recorded in the spike notes ([02](../spikes/02-vinext-on-workers.md), [03](../spikes/03-vinext-on-headless-wordpress.md), [05](../spikes/05-payload-on-vinext.md)); don't retry known-broken paths without a newer vinext.
- WordPress revalidation relies on Cache tags, because path revalidation on KV is eventually consistent.
