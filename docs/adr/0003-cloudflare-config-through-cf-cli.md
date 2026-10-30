# ADR 0003: Cloudflare config through the cf CLI and API, no Wrangler files

## Status

Accepted, 2026-10-29.

## Context

Wrangler config files tend to collect account ids, hostnames and environment drift, and this repo is public. vinext 1.4 deploys through Cloudflare's `cf` CLI, which takes a typed config in TypeScript.

## Decision

- No `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` in the repo; they are gitignored.
- Each Worker has a `cloudflare.config.ts` (the `cf` CLI's typed config, not a Wrangler file) with its name and bindings. The account comes from `CLOUDFLARE_ACCOUNT_ID`.
- Secrets are declared in that config and uploaded from the environment by the app's `scripts/deploy.mjs` (`cf deploy --prebuilt --secrets-file`).
- Everything else, such as Access applications, service tokens and Workers Builds settings, is created through the Cloudflare API by scripts in the repo (`packages/access/scripts/provision-access.ts`, each app's `scripts/workers-builds.mjs`).

## Consequences

- A Cloudflare change is a script change in a PR, not a dashboard edit.
- Tools that assume Wrangler (for example Blume's Cloudflare adapter) are skipped in favour of a `cf deploy --prebuilt` step.
- See [spike 02](../spikes/02-vinext-on-workers.md) for the details.
