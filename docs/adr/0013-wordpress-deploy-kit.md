# ADR 0013: The WordPress deploy kit lives in wordpress-shared

## Status

Accepted, 2026-10-30.

## Context

Patronage's WordPress sites deploy with a shell script and a post-receive hook on the host. Copies of it had drifted between repos.

## Decision

- The canonical deploy kit (`deploy.sh`, the post-receive hook, `deploy.env.sample` and its tests) is `wordpress-shared/wp-deploy`, versioned with a changelog.
- A WordPress install links to it from its `_build/` folder and keeps only its own `deploy.env` and include and exclude lists.
- Host details such as IPs, paths and SSH users go in the install's gitignored `.env`, never in `deploy.env`.

## Consequences

- Deploy behaviour changes only in `wordpress-shared/wp-deploy`, with a version bump and `pnpm --filter @launch/wp-deploy test`.
- Other sites copy the kit from this repo.
