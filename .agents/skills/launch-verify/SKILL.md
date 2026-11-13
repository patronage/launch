---
name: launch-verify
description: Launch, doctor, drive and capture evidence for Launch's local front ends, the Payload app (apps/payload, local D1) and the headless WordPress front end (apps/web-wordpress with Docker WordPress), and for the MCP gateway (apps/mcp) writing to the local Payload through a real approval, in a real browser. Use to prove a change to pages, sections, forms, the admin or an MCP connector works before a PR. It never deploys or touches a hosted CMS.
---

# Verify Launch locally

Prove a change the way a visitor or editor would see it: start the app, drive a real user path in a browser, and keep evidence. `pnpm verify` (lint, typecheck, tests) is necessary but is not this proof. The proof is the screenshots and transcript a drive writes.

Every step goes through one helper, run from the repo root with Node 24 (`.nvmrc`):

```bash
node .agents/skills/launch-verify/scripts/verify.ts --help
```

| Surface | App | Port | Drives |
| --- | --- | --- | --- |
| `payload` | `apps/payload`, built and run by `vite preview` on local D1 and R2 | 4173 | `pages`, `apply-form`, `seo` |
| `web-wordpress` | `apps/web-wordpress` on `vite dev`, reading WordPress in Docker | 3000 | `pages` |
| `mcp` | `apps/mcp` on `vite dev`, with `payload` and a local stand-in for Cloudflare Access (`access`, port 8799) | 8787 | `payload-draft` |

The feature map is in [features/README.md](features/README.md). The Timber install renders its own pages in PHP and isn't covered here.

The helper refuses to point a local front end at a hosted CMS or give it production credentials. Never run `pnpm run deploy`, `pnpm run secrets`, `cf deploy` or `builds:configure` while verifying, and never drive a hosted site with this skill.

## Launch

Payload, once per checkout:

```bash
cp apps/payload/.env.example apps/payload/.env          # then set PAYLOAD_SECRET (openssl rand -hex 32)
cp apps/payload/.env apps/payload/.dev.vars
pnpm --filter payload seed                               # optional: the demo site; needs migrations, so run launch first on a fresh checkout
```

WordPress, once per machine (needs Docker). Use `run setup`: in pnpm 12, a bare `pnpm --filter … setup` is pnpm's own `setup` command.

```bash
pnpm --filter cms-wordpress-headless run setup           # WordPress on :8080, demo content, apps/web-wordpress/.env.local
```

The MCP gateway, once per checkout, after the Payload steps above. The gateway and Payload share one proof secret, and a local Worker reads a secret only from its own `.dev.vars`:

```bash
PROOF=$(openssl rand -hex 32)
echo "ACCESS_GATEWAY_PROOF_SECRET=$PROOF" >> apps/payload/.dev.vars
printf 'APPROVAL_CSRF_SECRET=%s\nPAYLOAD_ACCESS_PROOF_SECRET=%s\n' "$(openssl rand -hex 32)" "$PROOF" > apps/mcp/.dev.vars
```

Then start the surface:

```bash
node .agents/skills/launch-verify/scripts/verify.ts launch payload        # or: launch web-wordpress, launch mcp, --port N
```

`launch mcp` starts three servers this checkout owns, each with its own receipt: the Access stand-in (`access`), Payload built to trust it, and the gateway pointed at both. The stand-in signs JWTs for synthetic editors with a key it makes at start; only local servers started against it accept them. Stop them with `cleanup mcp`, `cleanup payload` and `cleanup access`.

Launch fails when Doctor fails, and it refuses in these cases:

- the port already has a listener, on 127.0.0.1 or ::1, that this run didn't start;
- a required env file is missing;
- `WORDPRESS_URL` isn't local, or the WordPress Access service token is set, in the shell or in any env file the app loads (`.env`, `.env.local`, `.env.development*`, `.dev.vars*`);
- `PAYLOAD_DB=postgres` is set;
- for `mcp`: the two secrets are missing or don't match, a Payload, WordPress or Access URL in the shell or `apps/mcp`'s env files isn't local, a service token or `PAYLOAD_WORKER` is set, or Payload is already running without the stand-in;
- `PAYLOAD_SECRET` is empty.

For Payload it runs `pnpm payload migrate` and `pnpm build` every time, so a stale build is never verified. For web-wordpress it runs `pnpm codegen`. It then starts the server in its own process group and records a receipt (`.state/<surface>/run.json`, with the pid, port, app directory and a token). The server log goes to `.state/<surface>/server.log`. Ready means launch ends with `Doctor: PASS`. If this checkout already runs an owned server on that port, launch reuses it.

Each checkout's local D1, R2 and KV state lives in `apps/<app>/.cloudflare` or `.wrangler`. Run one instance per surface per checkout. Separate worktrees can run their front ends side by side on different ports.

WordPress is the exception. Its Docker Compose project and database volume are shared by every checkout on the machine, so it serves whichever checkout last ran `setup`, and its content may have been edited by an earlier run. If a page shows content that isn't in the seed, reseed (`pnpm --filter cms-wordpress-headless run seed`), or reset it (`reset`, then `run setup`) when nobody else is using it.

## Doctor

```bash
node .agents/skills/launch-verify/scripts/verify.ts doctor payload
```

Doctor is read-only. When the environment check fails, it stops there and makes no network request. Otherwise it prints the surface, origin and checkout revision, then a PASS or FAIL line for each check:

- the environment is local;
- the receipt's process is alive and runs in this checkout's app directory;
- for web-wordpress, the WordPress GraphQL endpoint answers;
- for mcp, the stand-in and a Payload that trusts it are this checkout's, a request signed by the stand-in gets `200` from `/mcp`, and one with no sign-in is refused;
- each health route (`/`, `/news`, `/admin` for Payload, `/` and `/about` for WordPress, the signing keys for the stand-in) returns 200 after at most five same-origin redirects.

Fix the first FAIL line and run it again. Doctor never starts, migrates or seeds anything, and it fails on a server it has no receipt for, however healthy that server is.

On a fresh database without the seed, Payload's `/` lists pages instead of rendering a home page. Seed first if the feature needs demo content.

## Drive

Read [features/README.md](features/README.md), then the matching feature file. Scripted drives:

```bash
node .agents/skills/launch-verify/scripts/verify.ts drive payload pages
node .agents/skills/launch-verify/scripts/verify.ts drive payload apply-form
node .agents/skills/launch-verify/scripts/verify.ts drive payload seo
node .agents/skills/launch-verify/scripts/verify.ts drive web-wordpress pages
node .agents/skills/launch-verify/scripts/verify.ts drive mcp payload-draft
```

Drives use the repo's own Playwright (`apps/payload`'s dependency, the one `pnpm --filter payload smoke` uses), headless Chromium at 1280×900, and wait for `networkidle` before typing, because vinext hydrates after the first paint. Install Chromium once with `pnpm --filter payload exec playwright install chromium`, or set `VERIFY_CHROMIUM` to a Chromium binary.

To capture any other path, or to check a page by hand:

```bash
node .agents/skills/launch-verify/scripts/verify.ts capture payload /programs/seed-library seed-library
```

For an interactive look, any browser works against the same origin, Claude in Chrome included. Record what you did in a `notes.md` in the evidence directory.

## Evidence

Each `drive` or `capture` writes to `.agents/skills/launch-verify/evidence/<utc-stamp>-<surface>-<feature>/`. `VERIFY_EVIDENCE_DIR` overrides the root. Depending on the command, the directory holds:

- `transcript.md`: each user action next to what was observed, plus browser console errors;
- `NN-<step>.png`: numbered full-page screenshots of each action and its result;
- `page.html` and `response.json`, from `capture`: the status, final URL, headers and checkout SHA;
- `form-submissions.json`, from `apply-form`: the stored submission, read back as the local admin;
- `run.json`, from `payload-draft`: the gateway's receipt for the approved write, as `get_run` reports it;
- `server-log.txt`: the Worker's log lines during the run, which include each request's evlog wide event with `upstream.d1` or `upstream.wordpress` timings. The `cache` field (vinext's HIT, STALE or MISS) only appears on ISR pages served by a build (`vite preview`) or a deployed Worker. Under the web-wordpress `vite dev` surface and on Payload's `no-store` pages, it never appears. Events say `environment: 'production'` even locally.

Look at each screenshot against its transcript line before calling a run good. A form drive passes only when the POST succeeded, the confirmation showed, and the row came back from the API.

Evidence and `.state/` are gitignored. Never force-add them. Attach screenshots to a PR by uploading them, not by committing them.

## Cleanup

```bash
node .agents/skills/launch-verify/scripts/verify.ts cleanup payload
```

Cleanup signals only the process group in the receipt, and only after checking that the pid still runs in this checkout's app directory. It never kills by name or by port. If the identity check fails, it refuses and leaves the receipt in place. It keeps evidence, the server log and the local databases. Afterwards, confirm the evidence directory still exists and `verify.ts status` shows no running server.

To reset local Payload data on purpose, run cleanup first, then delete `apps/payload/.cloudflare/state` and launch and seed again. For WordPress, run `pnpm --filter cms-wordpress-headless reset`. Do this only in a checkout you own.

## Helpers

| File | What it does |
| --- | --- |
| `scripts/verify.ts` | `launch`, `doctor`, `capture`, `drive`, `cleanup` and `status`. Holds the receipts, the environment refusals and the redirect-limited probe |
| `scripts/drive.ts` | The Playwright drives. Add a drive here when a feature file gains a repeatable path |
| `scripts/access-standin.ts` | The local stand-in for a Cloudflare Access team domain: serves its signing key and signs JWTs for synthetic editors |
| `scripts/verify.test.ts` | Self-test: `node --test .agents/skills/launch-verify/scripts/verify.test.ts` |

When routes, seed slugs, field names or labels change, update the matching feature file and drive, then run the self-test and the drive.
