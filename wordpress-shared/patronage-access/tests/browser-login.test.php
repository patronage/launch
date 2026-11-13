<?php

declare(strict_types=1);

// Drives Patronage_Access_REST_Auth::browser_login() end to end against
// WordPress stubs: a valid Access login signs the matching editor in and
// redirects; anything else falls through to the login form.

define( 'ABSPATH', __DIR__ );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'YEAR_IN_SECONDS', 31536000 );
define( 'PATRONAGE_ACCESS_TEAM_DOMAIN', 'https://team.cloudflareaccess.com' );
define( 'PATRONAGE_ACCESS_AUD', 'cms-application-aud' );
define( 'PATRONAGE_ACCESS_BROWSER_LOGIN', true );

final class WP_Error {
	public function __construct(
		public string $code = '',
		public string $message = '',
		public mixed $data = null
	) {}

	public function get_error_code(): string {
		return $this->code;
	}
}

class WP_User {
	public function __construct(
		public int $ID,
		public string $user_login,
		/** @var array<int,string> */
		public array $caps
	) {}
}

final class Redirected extends RuntimeException {
	public function __construct( public string $location ) {
		parent::__construct( $location );
	}
}

/** @var array<string,mixed> */
$test_transients = array();
/** @var array<int,string> */
$test_events = array();
$test_logged_in = false;

function add_action( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {}
function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {}
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	return $value;
}
function do_action( string $hook, mixed ...$args ): void {
	global $test_events;
	$test_events[] = 'action:' . $hook;
}
function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}
function get_transient( string $key ): mixed {
	global $test_transients;
	return $test_transients[ $key ] ?? false;
}
function set_transient( string $key, mixed $value, int $expiration ): bool {
	global $test_transients;
	$test_transients[ $key ] = $value;
	return true;
}
function wp_parse_url( string $url ): array|false {
	return parse_url( $url );
}
function is_multisite(): bool {
	return false;
}
function is_user_logged_in(): bool {
	global $test_logged_in;
	return $test_logged_in;
}
function is_ssl(): bool {
	return true;
}
function get_user_by( string $field, string $value ): WP_User|false {
	return match ( $value ) {
		'editor@example.com' => new WP_User( 7, 'editor', array( 'edit_posts' ) ),
		'reader@example.com' => new WP_User( 8, 'reader', array( 'read' ) ),
		"o'neil&co@example.com" => new WP_User( 9, 'oneil', array( 'edit_posts' ) ),
		default              => false,
	};
}
function user_can( WP_User $user, string $capability ): bool {
	return in_array( $capability, $user->caps, true );
}
function wp_set_auth_cookie( int $user_id, bool $remember, bool $secure ): void {
	global $test_events;
	$test_events[] = 'cookie:' . $user_id;
}
function wp_set_current_user( int $user_id ): void {}
function wp_unslash( string|array $value ): string|array {
	return is_array( $value ) ? array_map( 'wp_unslash', $value ) : stripslashes( $value );
}
function wp_login_url(): string {
	return 'https://cms.example.com/wp-login.php';
}
function add_query_arg( string $key, string $value, string $url ): string {
	return $url . ( str_contains( $url, '?' ) ? '&' : '?' ) . rawurlencode( $key ) . '=' . rawurlencode( $value );
}
function admin_url(): string {
	return 'https://cms.example.com/wp-admin/';
}
function wp_validate_redirect( string $location, string $fallback ): string {
	return str_starts_with( $location, 'https://cms.example.com/' ) ? $location : $fallback;
}
function esc_url( string $url ): string {
	return htmlspecialchars( $url, ENT_QUOTES );
}
function esc_html( string $text ): string {
	return htmlspecialchars( $text, ENT_QUOTES );
}
function wp_safe_redirect( string $location ): never {
	throw new Redirected( $location );
}

require_once dirname( __DIR__ ) . '/patronage-access.php';

function b64url( string $value ): string {
	return rtrim( strtr( base64_encode( $value ), '+/', '-_' ), '=' );
}

$private = openssl_pkey_new( array( 'private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA ) );
$csr     = openssl_csr_new( array( 'commonName' => 'access.test' ), $private );
$pem     = '';
openssl_x509_export( openssl_csr_sign( $csr, null, $private, 1 ), $pem );
$test_transients[ 'patronage_access_certs_' . substr( hash( 'sha256', PATRONAGE_ACCESS_TEAM_DOMAIN ), 0, 32 ) ] = array( 'primary' => $pem );

/**
 * @param array<string,mixed> $overrides Claims to add or replace; null removes one.
 */
function token( OpenSSLAsymmetricKey $private, array $overrides = array() ): string {
	$claims = array_filter(
		array_merge(
			array(
				'aud'   => PATRONAGE_ACCESS_AUD,
				'email' => 'editor@example.com',
				'exp'   => time() + 300,
				'iss'   => PATRONAGE_ACCESS_TEAM_DOMAIN,
			),
			$overrides
		),
		static fn ( mixed $value ): bool => null !== $value
	);
	$input  = b64url( (string) json_encode( array( 'alg' => 'RS256', 'kid' => 'primary' ) ) ) . '.' . b64url( (string) json_encode( $claims ) );
	$signature = '';
	openssl_sign( $input, $signature, $private, OPENSSL_ALGO_SHA256 );
	return $input . '.' . b64url( $signature );
}

/**
 * Run browser_login once and report the redirect, or null when it fell through.
 *
 * @param array<string,string> $query
 */
function attempt( ?string $jwt, array $query = array( 'patronage_access_login' => '1' ), string $method = 'GET', bool $guard = true, bool $opted_out = false, array $headers = array() ): ?string {
	global $test_events;
	$test_events                = array();
	$_GET                       = $query;
	$_COOKIE                    = $guard ? array( 'patronage_access_login_tried' => '1' ) : array();
	if ( $opted_out ) {
		$_COOKIE['patronage_access_off'] = '1';
	}
	$_SERVER['REQUEST_METHOD']  = $method;
	unset( $_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'], $_SERVER['HTTP_SEC_FETCH_SITE'], $_SERVER['HTTP_ORIGIN'], $_SERVER['HTTP_REFERER'] );
	foreach ( $headers as $key => $value ) {
		$_SERVER[ $key ] = $value;
	}
	if ( null !== $jwt ) {
		$_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] = $jwt;
	}
	try {
		Patronage_Access_REST_Auth::browser_login();
	} catch ( Redirected $redirect ) {
		return $redirect->location;
	}
	return null;
}

function check( bool $ok, string $name ): void {
	if ( ! $ok ) {
		fwrite( STDERR, $name . " failed.\n" );
		exit( 1 );
	}
}

ini_set( 'error_log', '/dev/null' );

check(
	'https://cms.example.com/wp-login.php?redirect_to=https%3A%2F%2Fcms.example.com%2Fwp-admin%2F&reauth=1&patronage_access_login=1'
		=== attempt( token( $private ), array( 'redirect_to' => 'https://cms.example.com/wp-admin/', 'reauth' => '1' ), 'GET', false ),
	'first visit probes the guard cookie and keeps redirect_to'
);
check( array() === $test_events, 'probe signs nobody in' );
check( null === attempt( token( $private ), array( 'patronage_access_login' => '1' ), 'GET', false ), 'cookies refused: login form, no loop' );
check( null === attempt( token( $private ), array(), 'GET', true ), 'sent back after a sign-in: login form, no loop' );
check( 'https://cms.example.com/wp-admin/' === attempt( token( $private ) ), 'editor signs in to wp-admin' );
check( array( 'cookie:7', 'action:wp_login' ) === $test_events, 'auth cookie set and wp_login fired' );
check( 'https://cms.example.com/wp-admin/post.php?post=1' === attempt( token( $private ), array( 'patronage_access_login' => '1', 'redirect_to' => 'https://cms.example.com/wp-admin/post.php?post=1' ) ), 'redirect_to kept' );
check( 'https://cms.example.com/wp-admin/' === attempt( token( $private ), array( 'patronage_access_login' => '1', 'redirect_to' => 'https://evil.example.net/' ) ), 'off-site redirect_to replaced' );
check( null === attempt( null ), 'no assertion shows the form' );
check( null === attempt( token( $private, array( 'email' => 'reader@example.com' ) ) ), 'user without edit_posts shows the form' );
check( null === attempt( token( $private, array( 'email' => 'stranger@example.com' ) ) ), 'unknown email shows the form' );
check( null === attempt( token( $private, array( 'email' => null, 'common_name' => 'client.access' ) ) ), 'service token shows the form' );
check( null === attempt( token( $private, array( 'aud' => 'another-application' ) ) ), 'other application shows the form' );
check( null === attempt( 'forged.assertion.value' ), 'forged assertion shows the form' );
check( null === attempt( token( $private ), array( 'patronage_access_login' => '1', 'loggedout' => 'true' ) ), 'logout shows the form' );
check( null === attempt( token( $private ), array( 'patronage_access_login' => '1' ), 'POST' ), 'form post untouched' );
check( array() === $test_events, 'nothing signed in on fall-through' );

// The hour after logout: the opt-out cookie keeps the form up.
check( null === attempt( token( $private ), array(), 'GET', false, true ), 'opted out: no probe' );
check( null === attempt( token( $private ), array( 'patronage_access_login' => '1' ), 'GET', true, true ), 'opted out: no sign-in' );
check( array() === $test_events, 'nothing signed in while opted out' );

// "Sign in with Access" posts back to wp-login.php and restarts the flow.
$resume = array( 'action' => 'patronage_access_sign_in', 'redirect_to' => 'https://cms.example.com/wp-admin/edit.php' );
$resumed = 'https://cms.example.com/wp-login.php?redirect_to=https%3A%2F%2Fcms.example.com%2Fwp-admin%2Fedit.php&patronage_access_login=1';
check( $resumed === attempt( token( $private ), $resume, 'POST', false, true, array( 'HTTP_SEC_FETCH_SITE' => 'same-origin' ) ), 'same-origin button post restarts browser login' );
check( array() === $test_events, 'the button post itself signs nobody in' );
check( $resumed === attempt( token( $private ), $resume, 'POST', false, true, array( 'HTTP_ORIGIN' => 'https://cms.example.com' ) ), 'Origin fallback accepted' );
check( $resumed === attempt( token( $private ), $resume, 'POST', false, true, array( 'HTTP_REFERER' => 'https://cms.example.com/wp-login.php?loggedout=true' ) ), 'Referer fallback accepted' );
check( null === attempt( token( $private ), $resume, 'POST', false, true, array( 'HTTP_SEC_FETCH_SITE' => 'cross-site', 'HTTP_ORIGIN' => 'https://cms.example.com' ) ), 'cross-site post refused even with a matching Origin' );
check( null === attempt( token( $private ), $resume, 'POST', false, true, array( 'HTTP_ORIGIN' => 'https://evil.example.net' ) ), 'foreign Origin refused' );
check( null === attempt( token( $private ), $resume, 'POST', false, true, array( 'HTTP_ORIGIN' => 'null', 'HTTP_REFERER' => 'https://cms.example.com.evil.example.net/' ) ), 'lookalike Referer refused' );
check( null === attempt( token( $private ), $resume, 'POST', false, true ), 'post with no origin headers refused' );
check( null === attempt( token( $private ), $resume, 'GET', false, true, array( 'HTTP_SEC_FETCH_SITE' => 'same-origin' ) ), 'GET of the button action does nothing' );
check( null === attempt( null, $resume, 'POST', false, true, array( 'HTTP_SEC_FETCH_SITE' => 'same-origin' ) ), 'button post without an assertion does nothing' );

check( Patronage_Access_JWT_Verifier::is_same_origin_post( array( 'HTTP_ORIGIN' => 'https://CMS.example.com:443' ), 'https://cms.example.com' ), 'origin compare ignores case and default port' );
check( ! Patronage_Access_JWT_Verifier::is_same_origin_post( array( 'HTTP_ORIGIN' => 'http://cms.example.com' ), 'https://cms.example.com' ), 'origin compare checks scheme' );
check( ! Patronage_Access_JWT_Verifier::is_same_origin_post( array( 'HTTP_ORIGIN' => 'https://cms.example.com:8443' ), 'https://cms.example.com' ), 'origin compare checks port' );

/**
 * Render the login screen's message area for a request.
 *
 * @param array<string,string> $query
 */
function button( ?string $jwt, array $query = array( 'loggedout' => 'true' ) ): string {
	$_GET = $query;
	unset( $_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] );
	if ( null !== $jwt ) {
		$_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] = $jwt;
	}
	return (string) Patronage_Access_REST_Auth::sign_in_button( '<p class="message">You are now logged out.</p>' );
}

$shown = button( token( $private ), array( 'loggedout' => 'true', 'redirect_to' => 'https://cms.example.com/wp-admin/?a=1&b="x"' ) );
check( str_starts_with( $shown, '<p class="message">You are now logged out.</p><form method="post" action="https://cms.example.com/wp-login.php?redirect_to=https%3A%2F%2Fcms.example.com%2Fwp-admin%2F%3Fa%3D1%26b%3D%22x%22&amp;action=patronage_access_sign_in"' ), 'button posts to the sign-in action and keeps redirect_to' );
check( str_contains( $shown, '>Sign in with Access as editor@example.com</button>' ), 'button names the verified email' );
check( str_contains( button( token( $private ), array() ), 'Sign in with Access as editor@example.com' ), 'button on the plain form too' );
check( str_contains( button( token( $private, array( 'email' => "o'neil&co@example.com" ) ) ), '>Sign in with Access as o&#039;neil&amp;co@example.com</button>' ), 'email is escaped' );
check( ! str_contains( button( token( $private, array( 'email' => 'stranger@example.com' ) ) ), '<form' ), 'email without a matching user gets no button' );
check( '<p class="message">You are now logged out.</p>' === button( null ), 'no assertion, no button' );
check( '<p class="message">You are now logged out.</p>' === button( 'forged.assertion.value' ), 'forged assertion, no button' );
check( '<p class="message">You are now logged out.</p>' === button( token( $private, array( 'email' => 'reader@example.com' ) ) ), 'user without edit_posts, no button' );
check( '<p class="message">You are now logged out.</p>' === button( token( $private, array( 'aud' => 'another-application' ) ) ), 'other application, no button' );
check( '<p class="message">You are now logged out.</p>' === button( token( $private ), array( 'action' => 'lostpassword' ) ), 'other actions, no button' );
check( '<p class="message">You are now logged out.</p>' === button( token( $private ), array( 'interim-login' => '1' ) ), 'session-expired modal, no button' );

$test_logged_in = true;
check( null === attempt( token( $private ) ), 'signed-in user untouched' );
check( '<p class="message">You are now logged out.</p>' === button( token( $private ) ), 'signed-in user, no button' );

fwrite( STDOUT, "Browser login tests passed.\n" );
