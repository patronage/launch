# Patronage Access

A WordPress mu-plugin that locks a site behind Cloudflare Access. It does three separate jobs, each switched on by constants in `wp-config.php`:

1. **Origin guard.** Rejects any HTTP request that did not pass through Access, so the origin's own address or host-platform URL serves nothing.
2. **Browser login.** Signs an editor into wp-admin from their Access login, so passing Access is the only sign-in step.
3. **Gateway identity.** Authenticates REST and WPGraphQL requests as the WordPress user whose email matches an Access JWT forwarded by a gateway Worker, optionally bound to that Worker with an HMAC proof.

It needs PHP 8.0+ with the OpenSSL extension, and stays inactive when `openssl_verify` is unavailable. Ported from the Launch MCP plugin's REST authentication mu-plugin; the TypeScript side lives in `packages/access`.

## Install

With Composer, `composer require patronage/launch-access` from Launch's Composer repository, and add a one-line loader: see [Installing with Composer](../README.md#installing-with-composer). Without it, copy `patronage-access.php` into `wp-content/mu-plugins/`, as this repo's headless install does in `bin/build.sh`.

## Configuration

```php
// Required. The exact issuer: https, no trailing slash.
define( 'PATRONAGE_ACCESS_TEAM_DOMAIN', 'https://team.cloudflareaccess.com' );

// Audience (AUD tag) of the gateway's Access application, whose user JWTs
// the gateway forwards. An array is accepted during a migration.
define( 'PATRONAGE_ACCESS_AUD', 'gateway-application-aud' );

// Origin guard: off unless true.
define( 'PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT', true );
// Audience of the Access application in front of this site. Defaults to PATRONAGE_ACCESS_AUD.
define( 'PATRONAGE_ACCESS_ORIGIN_AUD', 'cms-application-aud' );

// Browser login: off unless true. Uses the origin audience.
define( 'PATRONAGE_ACCESS_BROWSER_LOGIN', true );

// Optional gateway proof (see below).
define( 'PATRONAGE_ACCESS_PROOF_SECRET', 'same value as the Worker secret' );

// Optional; defaults to X-Access-User-Jwt.
define( 'PATRONAGE_ACCESS_HEADER', 'X-Access-User-Jwt' );
```

`packages/access/scripts/provision-access.ts` prints the team domain and AUD after creating the Access application.

## Origin guard

Access on a hostname only protects traffic that reaches the origin through Cloudflare. With `PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT` on, every web request must carry a valid `Cf-Access-Jwt-Assertion` for the origin audience. User logins and service tokens both pass: the guard proves the request came through Access, not who sent it. A missing or invalid assertion gets a 403, and a misconfigured site fails closed with a 500.

The command line is exempt (WP-CLI, and system cron running `wp-cron.php` through PHP). WordPress's own loopback requests (`wp-cron.php` over HTTP, Site Health checks) go out to the public hostname and are stopped by Access, so set `DISABLE_WP_CRON` and run cron from the system scheduler.

## Browser login

Access and WordPress keep separate sessions, so without this an editor passes Access and then meets the WordPress login form. With `PATRONAGE_ACCESS_BROWSER_LOGIN` on, a plain GET of `wp-login.php` (where wp-admin sends signed-out users) that carries a `Cf-Access-Jwt-Assertion` is handled in two steps:

1. The plugin sets a 30-second guard cookie and redirects once to the same login URL with `patronage_access_login=1`, keeping `redirect_to`.
2. If the guard cookie came back, it verifies the assertion against the origin audience (`PATRONAGE_ACCESS_ORIGIN_AUD`, else `PATRONAGE_ACCESS_AUD`), maps the email to a WordPress user with `get_user_by( 'email' )`, checks the user has `edit_posts`, sets the normal auth cookie, fires `wp_login` and redirects to `redirect_to` through `wp_safe_redirect`.

Anything else shows the login form as usual and logs a reason (never the token or email) to the PHP error log: no assertion, a service token, an unknown email, a user without the capability, a browser that refused the guard cookie, or a browser WordPress sent straight back after a sign-in (so a rejected auth cookie cannot loop). Logout (`?loggedout=true`), other actions, POSTs, the session-expired modal and signed-in users are never touched, and `wp-login.php?patronage_access_login=off` shows the form once to sign in as someone else. The Access email must match the editor's WordPress email.

Filters: `patronage_access_browser_login_capability` (default `edit_posts`) and `patronage_access_browser_login_allowed` (receives the decision, the `WP_User` and the claims).

It works whether Access protects the whole hostname or only `/wp-admin` and `/wp-login.php`, and needs no origin guard.

## Gateway identity

A REST or WPGraphQL request carrying the configured header is authenticated from that JWT alone, whatever authenticated it first; a JWT this site rejects fails the request instead of falling back to another identity. Requests without the header are untouched, so wp-admin and other REST clients keep their normal behaviour. WPGraphQL reads then see the mapped user's drafts and private posts under WPGraphQL's own per-user rules.

The JWT must contain a valid email claim. WordPress resolves it with `get_user_by( 'email' )`; on multisite the account must belong to the current site unless it is a super admin. Service tokens carry no email, so they cannot act as a WordPress user.

The gateway forwards the user's token as `X-Access-User-Jwt`, not `Cf-Access-Jwt-Assertion`, because Cloudflare overwrites its own `Cf-Access-*` headers when the request crosses this site's Access application.

The verifier pins RS256 and checks the signature, exact issuer, an accepted audience, `exp` and `nbf` with 60 seconds of leeway, and the email. It fetches PEM certificates from `<team domain>/cdn-cgi/access/certs`, caches them for six hours, and refreshes once (throttled to a minute) when a token names an unknown `kid`. A failed fetch is remembered for a minute, and while Cloudflare can't be reached the last good certificates (kept a day past their cache) stand in, so an outage doesn't cost every request a fetch timeout.

After success it fires `do_action( 'patronage_access_authenticated', $user_id, $sub )`, and authenticated REST responses carry `X-Access-WordPress-User-ID` and `X-Access-WordPress-User-Slug` (the URL-encoded `user_nicename`, never the email) so the gateway can attribute writes.

## Gateway proof

Possession of a valid Access JWT should not be enough on its own. Define `PATRONAGE_ACCESS_PROOF_SECRET` to require `X-Access-Gateway-Proof: t=<unix>,v1=<hmac>` beside every forwarded JWT: HMAC-SHA256 over `"<t>." + sha256_hex(jwt)`, valid for ±300 seconds and bound to that one token. `computeGatewayProof` in `packages/access` produces it, and both test suites share one known-answer vector.

Roll out in this order: deploy the plugin, set the Worker secret, then define the constant. Once defined, a JWT without a valid proof is rejected, never downgraded.

## Test

```bash
pnpm --filter @patronage/wordpress-access test
```
