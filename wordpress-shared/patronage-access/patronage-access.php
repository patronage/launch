<?php
/**
 * Plugin Name: Patronage Access
 * Description: Locks WordPress behind Cloudflare Access. Optionally rejects any request that did not pass through Access, signs editors into wp-admin from their Access login, and authenticates REST and WPGraphQL requests as the user identified by a forwarded Access JWT, optionally requiring a gateway proof header.
 * Version: 1.0.2
 * License: MIT
 * Requires PHP: 8.0
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'PATRONAGE_ACCESS_TESTING' ) ) {
	exit;
}

/**
 * Pure Cloudflare Access JWT verifier.
 */
final class Patronage_Access_JWT_Verifier {
	private const LEEWAY_SECONDS      = 60;
	private const PROOF_SKEW_SECONDS  = 300;

	/**
	 * Decide whether the forwarded gateway JWT owns this request's identity.
	 * An authenticatable request carrying the gateway header is authenticated
	 * from that token alone: an application password, a cookie, or any earlier
	 * authenticator never wins over it. Without the header the earlier result
	 * stands, so wp-admin and non-gateway REST clients are untouched.
	 *
	 * @param bool   $is_authenticatable Whether this is a REST or WPGraphQL request.
	 * @param string $token              Forwarded gateway header value, empty when absent.
	 */
	public static function gateway_identity_decides( bool $is_authenticatable, string $token ): bool {
		return $is_authenticatable && '' !== $token;
	}

	/**
	 * Decide whether the origin guard checks this request. Command-line runs
	 * (WP-CLI, system cron calling wp-cron.php through PHP) never pass through
	 * Cloudflare, so they are exempt; every HTTP request is checked.
	 *
	 * @param bool   $enabled   Whether PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT is on.
	 * @param string $sapi      PHP_SAPI for this process.
	 * @param bool   $is_wp_cli Whether WP-CLI is running.
	 */
	public static function origin_guard_applies( bool $enabled, string $sapi, bool $is_wp_cli ): bool {
		return $enabled && 'cli' !== $sapi && ! $is_wp_cli;
	}

	/**
	 * Decide what browser login does with this wp-login.php request: 'skip'
	 * (show the login form as usual), 'probe' (set the loop guard cookie and
	 * come back once with `patronage_access_login=1`), or 'login' (the guard
	 * cookie survived the round trip, so verify the Access assertion).
	 *
	 * Only a plain GET of the login screen qualifies. Logging out lands on
	 * `?loggedout=true`, which must show the form or nobody could stay logged
	 * out; other actions (lost password, register, post password, the editor's
	 * session-expired modal) are left alone, and `?patronage_access_login=off`
	 * shows the form once so someone can sign in as a different user.
	 *
	 * The guard cookie makes the flow finite. Seen on an unmarked request, it
	 * means a sign-in just happened and WordPress still sent the browser back
	 * here, so the form shows instead of looping. Missing on the marked
	 * request, it means the browser is refusing cookies, so the form shows too.
	 *
	 * @param bool                $enabled   Whether PATRONAGE_ACCESS_BROWSER_LOGIN is on.
	 * @param string              $method    Request method.
	 * @param array<string,mixed> $query     Query parameters.
	 * @param bool                $logged_in Whether WordPress already has a user.
	 * @param bool                $guard     Whether the loop guard cookie is present.
	 */
	public static function browser_login_step( bool $enabled, string $method, array $query, bool $logged_in, bool $guard ): string {
		if ( ! $enabled || $logged_in || 'GET' !== strtoupper( $method ) ) {
			return 'skip';
		}
		if ( 'login' !== ( $query['action'] ?? 'login' ) ) {
			return 'skip';
		}
		foreach ( array( 'loggedout', 'interim-login' ) as $skip ) {
			if ( array_key_exists( $skip, $query ) ) {
				return 'skip';
			}
		}
		$marker = $query['patronage_access_login'] ?? null;
		if ( null === $marker ) {
			return $guard ? 'skip' : 'probe';
		}
		return '1' === $marker && $guard ? 'login' : 'skip';
	}

	/**
	 * Verify a gateway proof header binding a forwarded JWT to the
	 * gateway that sent it. The proof is `t=<unix>,v1=<hex hmac>` where the
	 * HMAC is hmac_sha256( secret, "<t>." . sha256_hex( jwt ) ). Binding the
	 * proof to the token and a timestamp means a captured JWT alone cannot be
	 * replayed against WordPress from outside the gateway, and a captured
	 * proof expires with its timestamp and matches only that token.
	 *
	 * @param string $proof  Raw proof header value.
	 * @param string $jwt    The forwarded JWT the proof must bind to.
	 * @param string $secret Shared gateway secret.
	 * @param int    $now    Current Unix timestamp.
	 * @return true|string True or a bounded failure reason.
	 */
	public static function verify_gateway_proof( string $proof, string $jwt, string $secret, int $now ): bool|string {
		if ( 1 !== preg_match( '/^t=([0-9]{1,20}),v1=([0-9a-f]{64})$/', $proof, $matches ) ) {
			return 'malformed_proof';
		}
		if ( abs( $now - (int) $matches[1] ) > self::PROOF_SKEW_SECONDS ) {
			return 'stale_proof';
		}
		$expected = hash_hmac( 'sha256', $matches[1] . '.' . hash( 'sha256', $jwt ), $secret );
		if ( ! hash_equals( $expected, $matches[2] ) ) {
			return 'proof_signature';
		}
		return true;
	}

	/**
	 * Verify a JWT using a kid-indexed map of PEM certificates.
	 *
	 * @param string               $jwt          Encoded JWT.
	 * @param array<string,string> $certs_by_kid PEM certificates indexed by kid.
	 * @param string               $issuer       Exact expected issuer.
	 * @param array<int,string>    $audiences    Accepted audiences.
	 * @param int                  $now          Current Unix timestamp.
	 * @param bool                 $require_email Require a user's email claim. The origin
	 *                                            guard passes false so service tokens pass.
	 * @return array<string,mixed>|string Claims or a bounded failure reason.
	 */
	public static function verify( string $jwt, array $certs_by_kid, string $issuer, array $audiences, int $now, bool $require_email = true ): array|string {
		$segments = explode( '.', $jwt );
		if ( count( $segments ) !== 3 || '' === $segments[0] || '' === $segments[1] || '' === $segments[2] ) {
			return 'malformed';
		}

		$header_json  = self::base64url_decode( $segments[0] );
		$payload_json = self::base64url_decode( $segments[1] );
		$signature    = self::base64url_decode( $segments[2] );
		if ( false === $header_json || false === $payload_json || false === $signature ) {
			return 'malformed';
		}

		$header = json_decode( $header_json, true );
		$claims = json_decode( $payload_json, true );
		if ( ! is_array( $header ) || ! is_array( $claims ) ) {
			return 'malformed';
		}

		if ( ! isset( $header['alg'] ) || 'RS256' !== $header['alg'] ) {
			return 'alg';
		}

		$kid = $header['kid'] ?? null;
		if ( ! is_string( $kid ) || '' === $kid ) {
			return 'unknown_kid';
		}

		$certificate = $certs_by_kid[ $kid ] ?? null;
		if ( ! is_string( $certificate ) || '' === $certificate ) {
			return 'unknown_kid';
		}

		$public_key = openssl_pkey_get_public( $certificate );
		if ( false === $public_key ) {
			return 'bad_cert';
		}

		$verified = openssl_verify(
			$segments[0] . '.' . $segments[1],
			$signature,
			$public_key,
			OPENSSL_ALGO_SHA256
		);
		if ( 1 !== $verified ) {
			return 'signature';
		}

		if ( ! isset( $claims['iss'] ) || ! is_string( $claims['iss'] ) || $issuer !== $claims['iss'] ) {
			return 'issuer';
		}

		if ( ! self::audience_matches( $claims['aud'] ?? null, $audiences ) ) {
			return 'audience';
		}

		$expires_at = self::numeric_date( $claims['exp'] ?? null );
		if ( null === $expires_at ) {
			return 'malformed';
		}
		if ( $now > $expires_at + self::LEEWAY_SECONDS ) {
			return 'expired';
		}

		if ( array_key_exists( 'nbf', $claims ) ) {
			$not_before = self::numeric_date( $claims['nbf'] );
			if ( null === $not_before ) {
				return 'malformed';
			}
			if ( $now + self::LEEWAY_SECONDS < $not_before ) {
				return 'not_yet_valid';
			}
		}

		if ( ! $require_email ) {
			return $claims;
		}

		$email = $claims['email'] ?? null;
		if ( ! is_string( $email ) || false === filter_var( $email, FILTER_VALIDATE_EMAIL ) ) {
			return 'no_email';
		}

		return $claims;
	}

	/**
	 * Decode a base64url segment using strict base64 validation.
	 */
	private static function base64url_decode( string $value ): string|false {
		if ( 1 === strlen( $value ) % 4 || 1 !== preg_match( '/^[A-Za-z0-9_-]+$/', $value ) ) {
			return false;
		}

		$padding = ( 4 - strlen( $value ) % 4 ) % 4;
		return base64_decode( strtr( $value, '-_', '+/' ) . str_repeat( '=', $padding ), true );
	}

	/**
	 * Determine whether a scalar or array aud claim contains an accepted value.
	 *
	 * @param mixed             $claim     JWT aud claim.
	 * @param array<int,string> $audiences Accepted audiences.
	 */
	private static function audience_matches( mixed $claim, array $audiences ): bool {
		$claimed_audiences = is_string( $claim ) ? array( $claim ) : $claim;
		if ( ! is_array( $claimed_audiences ) ) {
			return false;
		}

		foreach ( $claimed_audiences as $claimed_audience ) {
			if ( is_string( $claimed_audience ) && in_array( $claimed_audience, $audiences, true ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Parse an integer-valued JWT NumericDate.
	 */
	private static function numeric_date( mixed $value ): ?int {
		if ( is_int( $value ) ) {
			return $value;
		}
		if ( is_float( $value ) && is_finite( $value ) && floor( $value ) === $value ) {
			return (int) $value;
		}
		return null;
	}
}

if ( ! function_exists( 'openssl_verify' ) || defined( 'PATRONAGE_ACCESS_TESTING' ) ) {
	return;
}

/**
 * WordPress integration for Access JWT authentication.
 */
final class Patronage_Access_REST_Auth {
	private const CACHE_SECONDS = 6 * HOUR_IN_SECONDS;
	// How long after it goes stale the last good certificate set may still
	// stand in while Cloudflare cannot be reached.
	private const CERTS_STALE_SECONDS = 24 * HOUR_IN_SECONDS;
	// How long a failed certificate fetch is remembered, so an outage costs
	// one slow request a minute rather than one per request.
	private const CERTS_FAILURE_SECONDS = 60;
	private const CERTS_TIMEOUT_SECONDS = 5;
	private const DEFAULT_HEADER = 'X-Access-User-Jwt';
	private const LOGIN_GUARD_COOKIE = 'patronage_access_login_tried';
	private const LOGIN_GUARD_SECONDS = 30;
	private const ORIGIN_HEADER = 'Cf-Access-Jwt-Assertion';
	private const PROOF_HEADER = 'X-Access-Gateway-Proof';
	private const REFRESH_THROTTLE_SECONDS = 60;
	private const USER_ID_HEADER = 'X-Access-WordPress-User-ID';
	private const USER_SLUG_HEADER = 'X-Access-WordPress-User-Slug';

	private static bool $attempted = false;
	private static bool $authenticated = false;
	private static ?WP_Error $error = null;
	/** @var array{id:int,slug:string}|null */
	private static ?array $wordpress_actor = null;

	/**
	 * Register WordPress authentication hooks.
	 */
	public static function register(): void {
		add_action( 'plugins_loaded', array( self::class, 'guard_origin' ), -1000 );
		add_action( 'login_init', array( self::class, 'browser_login' ), 1 );
		add_filter( 'determine_current_user', array( self::class, 'determine_current_user' ), 30 );
		add_filter( 'rest_authentication_errors', array( self::class, 'rest_authentication_errors' ) );
		add_filter( 'rest_post_dispatch', array( self::class, 'identify_rest_actor' ), 10, 3 );
		add_filter( 'graphql_authentication_errors', array( self::class, 'graphql_authentication_errors' ), 20, 2 );
		add_action( 'graphql_process_http_request', array( self::class, 'authenticate_graphql_request' ), 1 );
		add_filter( 'graphql_response_status_code', array( self::class, 'graphql_response_status_code' ) );
		add_action( 'do_graphql_request', array( self::class, 'block_failed_graphql_request' ) );
	}

	/**
	 * Authenticate the request and return its WordPress user ID.
	 *
	 * When a REST or WPGraphQL request carries the configured gateway header,
	 * the verified JWT is the only identity that counts: this authenticator
	 * runs regardless of $user_id, so an application password, a cookie, or
	 * any earlier authenticator can never win for a gateway request. A failed
	 * verification is recorded and returns false rather than falling back.
	 * When the header is absent, $user_id is returned unchanged.
	 *
	 * @param int|false $user_id A user ID from an earlier authentication method.
	 * @return int|false
	 */
	public static function determine_current_user( int|false $user_id ): int|false {
		$authenticatable = self::is_authenticatable_request();
		$token           = (string) self::request_header( self::configured_header() );
		if ( ! Patronage_Access_JWT_Verifier::gateway_identity_decides( $authenticatable, $token ) ) {
			return $user_id;
		}

		self::$attempted = true;

		$proof_error = self::check_gateway_proof( $token );
		if ( null !== $proof_error ) {
			self::$error = $proof_error;
			return false;
		}

		$config = self::config( 'PATRONAGE_ACCESS_AUD' );
		if ( is_wp_error( $config ) ) {
			self::$error = $config;
			return false;
		}

		$result = self::verify_token( $token, $config, true );
		if ( is_wp_error( $result ) ) {
			self::$error = $result;
			return false;
		}

		$user = get_user_by( 'email', $result['email'] );
		if ( false === $user || ! self::user_can_access_site( $user->ID ) ) {
			self::$error = self::auth_error( 'patronage_access_no_user', 'No WordPress account matches the Access login.', 403 );
			return false;
		}

		self::$authenticated = true;
		self::$wordpress_actor = array(
			'id'   => (int) $user->ID,
			'slug' => rawurlencode( (string) $user->user_nicename ),
		);
		$subject             = isset( $result['sub'] ) && is_string( $result['sub'] ) ? $result['sub'] : '';
		do_action( 'patronage_access_authenticated', $user->ID, $subject );
		return $user->ID;
	}

	/**
	 * Apply this authenticator's result to the REST request. A recorded
	 * gateway rejection wins over $result, so an earlier authenticator's
	 * success cannot mask it. Requests without the gateway header leave
	 * $result untouched.
	 *
	 * @param WP_Error|null|true $result Existing authentication result.
	 * @return WP_Error|null|true
	 */
	public static function rest_authentication_errors( WP_Error|null|true $result ): WP_Error|null|true {
		wp_get_current_user();

		if ( self::$error instanceof WP_Error ) {
			return self::$error;
		}
		if ( self::$attempted && self::$authenticated ) {
			return true;
		}
		return $result;
	}

	/**
	 * Identify the WordPress account that handled an authenticated REST request.
	 *
	 * The Worker uses this bounded, non-email identity for request attribution
	 * and approved-write audit events. It lets an incident responder connect an
	 * explicit decision to the same WordPress user Simple History records
	 * without logging the Access email or JWT subject.
	 *
	 * @param mixed $response REST response object.
	 * @return mixed
	 */
	public static function identify_rest_actor( mixed $response ): mixed {
		if ( ! self::$authenticated || null === self::$wordpress_actor || ! is_object( $response ) || ! method_exists( $response, 'header' ) ) {
			return $response;
		}
		$response->header( self::USER_ID_HEADER, (string) self::$wordpress_actor['id'] );
		$response->header( self::USER_SLUG_HEADER, self::$wordpress_actor['slug'] );
		return $response;
	}

	/**
	 * Keep WPGraphQL from downgrading a verified gateway user to a guest.
	 *
	 * WPGraphQL 2.17 treats an authenticated request without an Authorization
	 * header or WordPress nonce as cookie authentication and clears the user.
	 * Our forwarded Access JWT is CSRF-safe and has already been verified, so
	 * the plugin's documented authentication filter should preserve it. Never
	 * hide an error another authenticator supplied.
	 *
	 * @param WP_Error|null|bool $result Existing GraphQL authentication result.
	 * @return WP_Error|null|bool
	 */
	public static function graphql_authentication_errors( WP_Error|null|bool $result ): WP_Error|null|bool {
		if ( null === $result && self::$attempted && self::$authenticated ) {
			return false;
		}
		return $result;
	}

	/**
	 * Reject any HTTP request that did not pass through Cloudflare Access.
	 *
	 * Access in front of the hostname only protects traffic that reaches the
	 * origin through Cloudflare. With PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT on,
	 * the origin also refuses a request whose `Cf-Access-Jwt-Assertion` is
	 * missing or invalid, so a direct hit on the origin's address or host
	 * platform URL gets nothing. Service tokens pass: this proves the request
	 * came through Access, not who the user is.
	 */
	public static function guard_origin(): void {
		$enabled = defined( 'PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT' ) && true === constant( 'PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT' );
		if ( ! Patronage_Access_JWT_Verifier::origin_guard_applies( $enabled, PHP_SAPI, defined( 'WP_CLI' ) && WP_CLI ) ) {
			return;
		}

		$error = self::check_origin();
		if ( null !== $error ) {
			self::deny_origin( $error );
		}
	}

	/**
	 * Sign a browser into WordPress from its Access login.
	 *
	 * With PATRONAGE_ACCESS_BROWSER_LOGIN on, a plain visit to wp-login.php
	 * (where wp-admin sends signed-out users) verifies the
	 * `Cf-Access-Jwt-Assertion` Access adds for the application in front of
	 * this site, maps its email to a WordPress user who has the capability
	 * (edit_posts unless filtered), sets the normal auth cookie and redirects
	 * to `redirect_to`. It first bounces once through a guard cookie (see
	 * browser_login_step) so a browser that refuses cookies, or a WordPress
	 * that rejects the new auth cookie, ends on the login form instead of
	 * looping. Anything it cannot verify falls through to the login form; it
	 * never blocks a request.
	 */
	public static function browser_login(): void {
		$enabled = defined( 'PATRONAGE_ACCESS_BROWSER_LOGIN' ) && true === constant( 'PATRONAGE_ACCESS_BROWSER_LOGIN' );
		$method  = isset( $_SERVER['REQUEST_METHOD'] ) && is_string( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : '';
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only routing decision.
		$query = $_GET;
		$token = (string) self::request_header( self::ORIGIN_HEADER );
		if ( '' === $token ) {
			return;
		}

		$step = Patronage_Access_JWT_Verifier::browser_login_step( $enabled, $method, $query, is_user_logged_in(), isset( $_COOKIE[ self::LOGIN_GUARD_COOKIE ] ) );
		if ( 'probe' === $step ) {
			self::set_login_guard_cookie();
			wp_safe_redirect( add_query_arg( 'patronage_access_login', '1', wp_login_url() . self::login_query_string( $query ) ) );
			exit;
		}
		if ( 'login' !== $step ) {
			return;
		}

		$config = self::config( defined( 'PATRONAGE_ACCESS_ORIGIN_AUD' ) ? 'PATRONAGE_ACCESS_ORIGIN_AUD' : 'PATRONAGE_ACCESS_AUD' );
		if ( is_wp_error( $config ) ) {
			self::log_login( 'not configured' );
			return;
		}

		$claims = self::verify_token( $token, $config, true );
		if ( is_wp_error( $claims ) ) {
			self::log_login( $claims->get_error_code() );
			return;
		}

		$user = get_user_by( 'email', $claims['email'] );
		if ( ! ( $user instanceof WP_User ) || ! self::user_can_access_site( $user->ID ) ) {
			self::log_login( 'no matching WordPress user' );
			return;
		}

		$capability = (string) apply_filters( 'patronage_access_browser_login_capability', 'edit_posts' );
		$allowed    = (bool) apply_filters( 'patronage_access_browser_login_allowed', user_can( $user, $capability ), $user, $claims );
		if ( ! $allowed ) {
			self::log_login( 'user ' . $user->ID . ' may not sign in this way' );
			return;
		}

		wp_set_auth_cookie( $user->ID, false, is_ssl() );
		wp_set_current_user( $user->ID );
		do_action( 'wp_login', $user->user_login, $user );

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$requested = isset( $query['redirect_to'] ) && is_string( $query['redirect_to'] ) ? wp_unslash( $query['redirect_to'] ) : '';
		$redirect  = apply_filters( 'login_redirect', '' !== $requested ? $requested : admin_url(), $requested, $user );
		wp_safe_redirect( wp_validate_redirect( (string) $redirect, admin_url() ) );
		exit;
	}

	/**
	 * Carry the login screen's own query (redirect_to, reauth) through the probe.
	 *
	 * @param array<string,mixed> $query
	 */
	private static function login_query_string( array $query ): string {
		$kept = array_filter( wp_unslash( $query ), static fn ( mixed $value ): bool => is_string( $value ) );
		unset( $kept['patronage_access_login'] );
		return array() === $kept ? '' : '?' . http_build_query( $kept );
	}

	private static function set_login_guard_cookie(): void {
		setcookie(
			self::LOGIN_GUARD_COOKIE,
			'1',
			array(
				'domain'   => defined( 'COOKIE_DOMAIN' ) && is_string( COOKIE_DOMAIN ) ? COOKIE_DOMAIN : '',
				'expires'  => time() + self::LOGIN_GUARD_SECONDS,
				'httponly' => true,
				'path'     => defined( 'COOKIEPATH' ) && is_string( COOKIEPATH ) && '' !== COOKIEPATH ? COOKIEPATH : '/',
				'samesite' => 'Lax',
				'secure'   => is_ssl(),
			)
		);
	}

	/**
	 * Record why browser login fell through to the form. Never logs the token
	 * or the email.
	 */
	private static function log_login( string $reason ): void {
		error_log( '[patronage-access] browser login skipped: ' . $reason );
	}

	/**
	 * Check this request's `Cf-Access-Jwt-Assertion` against the origin
	 * audiences (PATRONAGE_ACCESS_ORIGIN_AUD, else PATRONAGE_ACCESS_AUD).
	 * A misconfigured site fails closed.
	 */
	public static function check_origin(): ?WP_Error {
		$config = self::config( defined( 'PATRONAGE_ACCESS_ORIGIN_AUD' ) ? 'PATRONAGE_ACCESS_ORIGIN_AUD' : 'PATRONAGE_ACCESS_AUD' );
		if ( is_wp_error( $config ) ) {
			return $config;
		}

		$token = (string) self::request_header( self::ORIGIN_HEADER );
		if ( '' === $token ) {
			return self::auth_error( 'patronage_access_origin_missing', 'Requests must come through Cloudflare Access.', 403 );
		}

		$result = self::verify_token( $token, $config, false );
		return is_wp_error( $result )
			? self::auth_error( 'patronage_access_origin_invalid', 'Requests must come through Cloudflare Access.', 403 )
			: null;
	}

	private static function deny_origin( WP_Error $error ): void {
		$data   = $error->get_error_data();
		$status = is_array( $data ) && isset( $data['status'] ) ? (int) $data['status'] : 403;
		wp_die( esc_html( $error->get_error_message() ), 'Forbidden', array( 'response' => $status ) );
		exit;
	}

	/**
	 * Verify a token against the team's certificates, refreshing them once
	 * (throttled) when the token names an unknown key.
	 *
	 * @param array{issuer:string,audiences:array<int,string>} $config
	 * @return array<string,mixed>|WP_Error
	 */
	private static function verify_token( string $token, array $config, bool $require_email ): array|WP_Error {
		$certificates = self::certificates( $config['issuer'], false );
		if ( is_wp_error( $certificates ) ) {
			return $certificates;
		}

		$result = Patronage_Access_JWT_Verifier::verify( $token, $certificates, $config['issuer'], $config['audiences'], time(), $require_email );

		if ( 'unknown_kid' === $result && self::may_refresh_certificates( $config['issuer'] ) ) {
			$certificates = self::certificates( $config['issuer'], true );
			if ( is_wp_error( $certificates ) ) {
				return $certificates;
			}
			$result = Patronage_Access_JWT_Verifier::verify( $token, $certificates, $config['issuer'], $config['audiences'], time(), $require_email );
		}

		if ( is_string( $result ) ) {
			return 'no_email' === $result
				? self::auth_error( 'patronage_access_no_email', 'Service tokens cannot act as a WordPress user.', 401 )
				: self::auth_error( 'patronage_access_invalid_token', 'WordPress rejected the Access token.', 401 );
		}

		return $result;
	}

	/**
	 * Read and validate the team domain and the audiences in $audience_constant.
	 *
	 * @return array{issuer:string,audiences:array<int,string>}|WP_Error
	 */
	private static function config( string $audience_constant ): array|WP_Error {
		if ( ! defined( 'PATRONAGE_ACCESS_TEAM_DOMAIN' ) || ! defined( $audience_constant ) ) {
			return self::not_configured_error();
		}

		$issuer    = constant( 'PATRONAGE_ACCESS_TEAM_DOMAIN' );
		$audiences = constant( $audience_constant );
		if ( ! is_string( $issuer ) || '' === $issuer || ! self::valid_issuer( $issuer ) ) {
			return self::not_configured_error();
		}

		if ( is_string( $audiences ) ) {
			$audiences = array( $audiences );
		}
		if ( ! is_array( $audiences ) || array() === $audiences ) {
			return self::not_configured_error();
		}
		foreach ( $audiences as $audience ) {
			if ( ! is_string( $audience ) || '' === $audience ) {
				return self::not_configured_error();
			}
		}

		return array(
			'audiences' => array_values( $audiences ),
			'issuer'    => $issuer,
		);
	}

	/**
	 * Fetch or read cached Access certificates indexed by kid.
	 *
	 * A failed fetch is remembered for CERTS_FAILURE_SECONDS, and until the
	 * next fetch succeeds the last good set (kept CERTS_STALE_SECONDS past its
	 * normal expiry) answers in its place. Without either, every request made
	 * while Cloudflare is unreachable would wait out its own fetch timeout.
	 *
	 * @return array<string,string>|WP_Error
	 */
	private static function certificates( string $issuer, bool $force_refresh ): array|WP_Error {
		$cache_key = self::cache_key( 'certs', $issuer );
		if ( ! $force_refresh ) {
			$cached = get_transient( $cache_key );
			if ( is_array( $cached ) && array() !== $cached ) {
				return $cached;
			}
		}

		$stale_key   = self::cache_key( 'certs_stale', $issuer );
		$failure_key = self::cache_key( 'certs_failed', $issuer );
		$stale       = get_transient( $stale_key );
		$stale       = is_array( $stale ) && array() !== $stale ? $stale : null;

		if ( false !== get_transient( $failure_key ) ) {
			return $stale ?? self::not_configured_error();
		}

		$fetched = self::fetch_certificates( $issuer );
		if ( is_wp_error( $fetched ) ) {
			set_transient( $failure_key, '1', self::CERTS_FAILURE_SECONDS );
			return $stale ?? $fetched;
		}

		set_transient( $cache_key, $fetched, self::CACHE_SECONDS );
		set_transient( $stale_key, $fetched, self::CACHE_SECONDS + self::CERTS_STALE_SECONDS );
		return $fetched;
	}

	/**
	 * Fetch Access certificates indexed by kid from the team domain.
	 *
	 * @return array<string,string>|WP_Error
	 */
	private static function fetch_certificates( string $issuer ): array|WP_Error {
		$response = wp_remote_get(
			rtrim( $issuer, '/' ) . '/cdn-cgi/access/certs',
			array(
				'redirection' => 0,
				'timeout'     => self::CERTS_TIMEOUT_SECONDS,
			)
		);
		if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
			return self::not_configured_error();
		}

		$body = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $body ) || ! isset( $body['public_certs'] ) || ! is_array( $body['public_certs'] ) ) {
			return self::not_configured_error();
		}

		$certificates = array();
		foreach ( $body['public_certs'] as $entry ) {
			if ( ! is_array( $entry ) || ! isset( $entry['kid'], $entry['cert'] ) ) {
				continue;
			}
			if ( is_string( $entry['kid'] ) && '' !== $entry['kid'] && is_string( $entry['cert'] ) && '' !== $entry['cert'] ) {
				$certificates[ $entry['kid'] ] = $entry['cert'];
			}
		}

		if ( array() === $certificates ) {
			return self::not_configured_error();
		}

		return $certificates;
	}

	/**
	 * Throttle refreshes caused by an unrecognized kid.
	 */
	private static function may_refresh_certificates( string $issuer ): bool {
		$key = self::cache_key( 'refresh', $issuer );
		if ( false !== get_transient( $key ) ) {
			return false;
		}
		set_transient( $key, '1', self::REFRESH_THROTTLE_SECONDS );
		return true;
	}

	private static function configured_header(): string {
		if ( ! defined( 'PATRONAGE_ACCESS_HEADER' ) ) {
			return self::DEFAULT_HEADER;
		}
		$header = constant( 'PATRONAGE_ACCESS_HEADER' );
		return is_string( $header ) && 1 === preg_match( '/^[A-Za-z0-9-]+$/', $header ) ? $header : self::DEFAULT_HEADER;
	}

	private static function request_header( string $header ): ?string {
		$key   = 'HTTP_' . strtoupper( str_replace( '-', '_', $header ) );
		$value = $_SERVER[ $key ] ?? null;
		return is_string( $value ) && '' !== $value ? $value : null;
	}

	private static function is_rest_request(): bool {
		return defined( 'REST_REQUEST' ) && REST_REQUEST;
	}

	/**
	 * WPGraphQL marks its HTTP requests the same way core marks REST ones.
	 * The function form is authoritative when WPGraphQL is active; the
	 * constant is the fallback so ordering cannot silently skip us.
	 */
	private static function is_graphql_request(): bool {
		if ( function_exists( 'is_graphql_http_request' ) ) {
			return (bool) is_graphql_http_request();
		}
		return defined( 'GRAPHQL_HTTP_REQUEST' ) && GRAPHQL_HTTP_REQUEST;
	}

	private static function is_authenticatable_request(): bool {
		return self::is_rest_request() || self::is_graphql_request();
	}

	/**
	 * Require the gateway proof header whenever a proof secret is configured.
	 * An undefined secret means the proof is not rolled out yet and the JWT
	 * stands alone; once defined, a JWT without a valid proof is rejected —
	 * never downgraded.
	 */
	private static function check_gateway_proof( string $token ): ?WP_Error {
		if ( ! defined( 'PATRONAGE_ACCESS_PROOF_SECRET' ) ) {
			return null;
		}
		$secret = constant( 'PATRONAGE_ACCESS_PROOF_SECRET' );
		if ( ! is_string( $secret ) || '' === $secret ) {
			return self::not_configured_error();
		}
		$proof = self::request_header( self::PROOF_HEADER );
		if ( null === $proof ) {
			return self::auth_error( 'patronage_access_missing_proof', 'The request did not come through the Access gateway.', 401 );
		}
		$result = Patronage_Access_JWT_Verifier::verify_gateway_proof( $proof, $token, $secret, time() );
		if ( true !== $result ) {
			return self::auth_error( 'patronage_access_invalid_proof', 'WordPress rejected the gateway proof.', 401 );
		}
		return null;
	}

	/**
	 * WordPress memoizes the current user, and another plugin may resolve it
	 * before WPGraphQL marks the request — in which case the lazy
	 * determine_current_user pass never sees this authenticator. Re-run our
	 * authentication explicitly when a token is present and unprocessed, and
	 * apply the mapped user so resolvers run as that account.
	 */
	private static function ensure_graphql_authentication(): void {
		if ( self::$attempted ) {
			return;
		}
		$token = self::request_header( self::configured_header() );
		if ( null === $token ) {
			return;
		}
		$current = get_current_user_id();
		$user_id = self::determine_current_user( $current > 0 ? $current : false );
		if ( is_int( $user_id ) && $user_id > 0 && get_current_user_id() !== $user_id ) {
			wp_set_current_user( $user_id );
		}
	}

	/**
	 * Authenticate before WPGraphQL constructs Request and its validation rules.
	 *
	 * WPGraphQL fires `graphql_process_http_request` immediately before creating
	 * Request. Its constructor decides whether introspection is public by reading
	 * the current user, so the later `do_graphql_request` hook cannot establish
	 * that identity in time. WordPress may also have cached an anonymous user
	 * before the GraphQL route was known; `ensure_graphql_authentication()` calls
	 * our authenticator directly and replaces that cached result.
	 */
	public static function authenticate_graphql_request(): void {
		self::ensure_graphql_authentication();
	}

	/**
	 * Mirror rest_authentication_errors for WPGraphQL: a rejected Access
	 * authentication sets the response status instead of executing anonymously.
	 *
	 * @param mixed $status_code Status WPGraphQL intends to send.
	 * @return mixed
	 */
	public static function graphql_response_status_code( $status_code ) {
		self::ensure_graphql_authentication();

		if ( self::$error instanceof WP_Error ) {
			$data = self::$error->get_error_data();
			return is_array( $data ) && isset( $data['status'] ) ? (int) $data['status'] : 401;
		}
		return $status_code;
	}

	/**
	 * Fail a GraphQL request whose Access authentication was rejected rather
	 * than letting it continue as an anonymous viewer.
	 */
	public static function block_failed_graphql_request(): void {
		self::ensure_graphql_authentication();

		if ( ! ( self::$error instanceof WP_Error ) ) {
			return;
		}
		if ( class_exists( '\GraphQL\Error\UserError' ) ) {
			throw new \GraphQL\Error\UserError( esc_html( self::$error->get_error_message() ) );
		}
		wp_send_json(
			array( 'errors' => array( array( 'message' => self::$error->get_error_message() ) ) ),
			401
		);
	}

	private static function user_can_access_site( int $user_id ): bool {
		if ( ! is_multisite() || is_super_admin( $user_id ) ) {
			return true;
		}
		return is_user_member_of_blog( $user_id, get_current_blog_id() );
	}

	private static function valid_issuer( string $issuer ): bool {
		$parts = wp_parse_url( $issuer );
		return is_array( $parts )
			&& 'https' === ( $parts['scheme'] ?? null )
			&& isset( $parts['host'] )
			&& ! isset( $parts['query'] )
			&& ! isset( $parts['fragment'] )
			&& ! isset( $parts['user'] )
			&& ! isset( $parts['pass'] );
	}

	private static function cache_key( string $purpose, string $issuer ): string {
		return 'patronage_access_' . $purpose . '_' . substr( hash( 'sha256', $issuer ), 0, 32 );
	}

	private static function auth_error( string $code, string $message, int $status ): WP_Error {
		return new WP_Error( $code, $message, array( 'status' => $status ) );
	}

	private static function not_configured_error(): WP_Error {
		return self::auth_error(
			'patronage_access_not_configured',
			"The WordPress site's Access authentication plugin is not configured.",
			500
		);
	}
}

Patronage_Access_REST_Auth::register();
