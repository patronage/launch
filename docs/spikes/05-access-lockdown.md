# Spike 5: Lock the CMS behind Cloudflare Access

Issue: #6. Question: what is the reference pattern for keeping the CMS behind Cloudflare Access while a public Worker serves the site?

## Result

The pattern has four layers, and the first three are now code in this repo:

| Layer | What it does | Where |
| --- | --- | --- |
| Access application | Puts the CMS hostname (or only `/admin` and `/api` for Payload) behind an Access login, with a `non_identity` policy for the Worker's service token | `packages/access` → `provisionLockdown`, `scripts/provision-access.ts` |
| Worker → CMS | The public Worker calls the CMS with its service token, and for previews forwards the editor's Access JWT with a gateway proof | `packages/access` → `accessFetch` |
| CMS verifies | WordPress: an origin guard that rejects requests without a valid `Cf-Access-Jwt-Assertion`, and REST/WPGraphQL authentication from a forwarded JWT. Payload: a custom auth strategy | `wordpress-shared/patronage-access`, `packages/access/payload` |
| Editor SSO | Editors reach wp-admin or the Payload admin through Access | Payload: the strategy above. WordPress: not ported yet (see follow-ups) |

Everything is unit-tested (38 TypeScript tests, two PHP suites, one shared known-answer vector for the gateway proof). The live run passed on 2026-10-30, with the WordPress CMS, its front-end previews and the Payload admin and API each behind their own Access application (see Live run below).

## How a request flows

```
visitor ──► web Worker (public) ──service token──► Access app ──► CMS origin
                                                     │                │
                                     sets Cf-Access-Jwt-Assertion     origin guard verifies it
                                     (service identity)               (rejects anything that skipped Access)

editor  ──► Access login ──► web Worker /preview ──service token + X-Access-User-Jwt + proof──► CMS
                                                     the CMS maps the forwarded JWT's email to a user
```

1. **Public pages.** The Worker sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Access admits it through the `non_identity` policy and hands the origin a JWT whose identity is the token's `common_name`, with no email. The CMS treats that as "came through Access, anonymous": published content only.
2. **Previews and drafts.** These need a real user. Put the Worker's preview route behind its own Access application so the Worker receives the editor's JWT, then forward it as `X-Access-User-Jwt` with `X-Access-Gateway-Proof`. WordPress authenticates REST and WPGraphQL as the user with that email, so drafts follow WordPress's own permissions. Set `PATRONAGE_ACCESS_AUD` to the preview application's AUD and `PATRONAGE_ACCESS_ORIGIN_AUD` to the CMS application's.
3. **Editors** go straight to the CMS hostname, log in through Access, and the CMS sees their JWT on every request.

## Findings

**Access on the hostname is not enough; the origin has to check too.** Access only filters traffic that comes through Cloudflare. A WordPress host still answers on its own platform URL or IP. Two ways to close that: a Cloudflare Tunnel (the origin has no public address), or verifying `Cf-Access-Jwt-Assertion` at the origin. Managed WordPress hosts generally cannot run `cloudflared`, so the JWT check is the portable default; the plugin's origin guard does it with `PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT`. Use a Tunnel as well where the host allows it.

**Service tokens have no email, by design.** The service-token JWT carries `common_name` (the client ID) and nothing that maps to a CMS user. The WordPress verifier and the Payload strategy both refuse to turn one into a user; the origin guard accepts it. This keeps the Worker's credential read-only by construction: it can never act as an editor.

**Forward the user's JWT under a custom header.** Cloudflare overwrites `Cf-Access-*` headers when a request crosses a second Access application, so a gateway that forwards the editor's token must use another name. `X-Access-User-Jwt` matches the existing MCP Worker, and `accessRequestHeaders` strips any caller-supplied copy before setting it.

**Bind forwarded JWTs to the gateway.** An Access JWT is a bearer token. The optional proof (HMAC over a timestamp and the token's SHA-256, ±300 seconds) means a leaked JWT alone cannot be replayed at the CMS. The TypeScript and PHP implementations share a known-answer vector so they cannot drift.

**Do not follow redirects to an Access origin.** When Access rejects a service token it can answer with a redirect to its login page, and a `fetch` that follows it returns a 200 HTML login page that looks like success. `accessFetch` sets `redirect: "manual"`, and `isAccessRejection` recognises both the 401/403 and the login redirect.

**Provisioning goes through the API.** Wrangler has no Access commands, and the repo bans Wrangler config anyway. `provisionLockdown` creates or updates the application, reusable policies and service tokens by name, so it is safe to re-run. A service token's secret is returned only on creation; on a re-run the script says so and the token has to be rotated to get a new secret. The API token needs Access: Apps and Policies Edit and Access: Service Tokens Edit. `--dry-run` prints the writes without sending them.

**WordPress loopbacks break behind the origin guard.** `wp-cron.php` over HTTP and Site Health's loopback checks call the public hostname and are stopped by Access. Set `DISABLE_WP_CRON` and run cron from the system scheduler; WP-CLI and other command-line runs are exempt from the guard.

**Payload stays one app with path rules.** Give the Access application two destinations, `cms.example.org/admin` and `cms.example.org/api`, and leave the rest public. Add `accessAuthStrategy()` to the users collection's `auth.strategies`; the admin's own browser calls to `/api` then carry the editor's assertion. Consider `disableLocalStrategy` on that collection so Access is the only way in. Front-end pages read through the Local API, which skips access control unless a call passes `overrideAccess: false`; the demo should pass it so the public site cannot read drafts by accident. Whether the strategy works unchanged under vinext is part of spike 4.

## What changed from the MCP plugin's mu-plugin

- Renamed to `patronage-access`: constants `PATRONAGE_ACCESS_*`, action `patronage_access_authenticated`, error codes `patronage_access_*`, response headers `X-Access-WordPress-User-ID` and `X-Access-WordPress-User-Slug`. The MCP Worker will need the same renames when it moves into `apps/mcp`.
- New origin guard (`PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT`, `PATRONAGE_ACCESS_ORIGIN_AUD`), with the verifier taking a `require_email` flag so service tokens pass the guard but never authenticate as users.
- The verification-and-refresh path is shared by the guard and the REST/WPGraphQL authenticator.

## Follow-ups

- **Live run (done, 2026-10-30).** Three Access applications: the WordPress CMS hostname; the front end's `/preview` and `/api/preview` paths on both its custom domain and its workers.dev host; and Payload's `/admin` and `/api`. The front end reads published content and media with a service token (`WORDPRESS_ACCESS_CLIENT_ID`, `WORDPRESS_ACCESS_CLIENT_SECRET`) and signs forwarded editor JWTs with `WORDPRESS_ACCESS_PROOF_SECRET`, all set as Worker secrets with `cf`. Results:
  - Public pages and media load.
  - An editor's preview of a draft works.
  - A direct request to the PHP origin without Access gets 403.
  - Signed-out requests to wp-admin and the Payload admin and API redirect to the Access login.
  - A forged JWT or proof sent with a valid service token gets 401.
  - WP cron runs from the system scheduler with `DISABLE_WP_CRON`, as the loopback finding above predicts.
- **Static uploads.** The origin guard runs in PHP, so files the web server serves directly from `wp-content/uploads` skip it. Close that at the host, or with a Tunnel where the host allows one.
- **wp-admin SSO.** Logging editors into wp-admin from their Access JWT (open as a PR in the old WordPress repo) belongs in this plugin next, so editors do not log in twice.
- **Payload against a real instance**, once spike 4 settles where Payload runs.
- **Docs-site pages**: one per layer in the table above.
