<?php

declare(strict_types=1);

define( 'ABSPATH', __DIR__ );
define( 'GRAPHQL_HTTP_REQUEST', true );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'PATRONAGE_ACCESS_TEAM_DOMAIN', 'https://team.cloudflareaccess.com' );
define( 'PATRONAGE_ACCESS_AUD', 'gateway-application-aud' );

final class WP_Error {
	public function __construct(
		public string $code = '',
		public string $message = '',
		public mixed $data = null
	) {}
}

final class WP_REST_Response {
	/** @var array<string,string> */
	public array $headers = array();

	public function header( string $key, string $value ): void {
		$this->headers[ $key ] = $value;
	}
}

/** @var array<string,array<int,array{callback:callable,accepted_args:int}>> */
$test_actions = array();
/** @var array<string,array<int,array{callback:callable,accepted_args:int}>> */
$test_filters = array();
/** @var array<string,mixed> */
$test_transients = array();
$test_current_user_id = 0;

function add_action( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	global $test_actions;
	$test_actions[ $hook ][ $priority ][] = array(
		'accepted_args' => $accepted_args,
		'callback'      => $callback,
	);
}

function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	global $test_filters;
	$test_filters[ $hook ][ $priority ][] = array(
		'accepted_args' => $accepted_args,
		'callback'      => $callback,
	);
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	global $test_filters;
	$callbacks = $test_filters[ $hook ] ?? array();
	ksort( $callbacks );
	foreach ( $callbacks as $at_priority ) {
		foreach ( $at_priority as $registered ) {
			$value = call_user_func_array(
				$registered['callback'],
				array_slice( array_merge( array( $value ), $args ), 0, $registered['accepted_args'] )
			);
		}
	}
	return $value;
}

function do_action( string $hook, mixed ...$args ): void {
	global $test_actions;
	$callbacks = $test_actions[ $hook ] ?? array();
	ksort( $callbacks );
	foreach ( $callbacks as $at_priority ) {
		foreach ( $at_priority as $registered ) {
			call_user_func_array(
				$registered['callback'],
				array_slice( $args, 0, $registered['accepted_args'] )
			);
		}
	}
}

function get_current_user_id(): int {
	global $test_current_user_id;
	return $test_current_user_id;
}

function wp_set_current_user( int $user_id ): void {
	global $test_current_user_id;
	$test_current_user_id = $user_id;
}

function get_user_by( string $field, string $value ): object|false {
	if ( 'email' !== $field || 'person@example.com' !== $value ) {
		return false;
	}
	return (object) array(
		'ID'            => 42,
		'user_nicename' => 'person',
	);
}

function is_multisite(): bool {
	return false;
}

function is_super_admin( int $user_id ): bool {
	return false;
}

function is_user_member_of_blog( int $user_id, int $blog_id ): bool {
	return true;
}

function get_current_blog_id(): int {
	return 1;
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

require_once dirname( __DIR__ ) . '/patronage-access.php';

function test_base64url_encode( string $value ): string {
	return rtrim( strtr( base64_encode( $value ), '+/', '-_' ), '=' );
}

/**
 * @return array{certificate:string,private:OpenSSLAsymmetricKey}
 */
function test_key_pair(): array {
	$private = openssl_pkey_new(
		array(
			'private_key_bits' => 2048,
			'private_key_type' => OPENSSL_KEYTYPE_RSA,
		)
	);
	if ( false === $private ) {
		throw new RuntimeException( 'Could not create test key.' );
	}
	$csr         = openssl_csr_new( array( 'commonName' => 'access.test' ), $private );
	$certificate = false === $csr ? false : openssl_csr_sign( $csr, null, $private, 1 );
	$pem         = '';
	if ( false === $certificate || ! openssl_x509_export( $certificate, $pem ) ) {
		throw new RuntimeException( 'Could not create test certificate.' );
	}
	return array( 'certificate' => $pem, 'private' => $private );
}

/**
 * @param array<string,mixed> $overrides Claims to add or replace; null removes a claim.
 */
function test_token( OpenSSLAsymmetricKey $private, array $overrides = array() ): string {
	$claims = array_merge(
		array(
			'aud'   => PATRONAGE_ACCESS_AUD,
			'email' => 'person@example.com',
			'exp'   => time() + 300,
			'iss'   => PATRONAGE_ACCESS_TEAM_DOMAIN,
			'nbf'   => time() - 10,
			'sub'   => 'opaque-subject',
		),
		$overrides
	);
	$claims  = array_filter( $claims, static fn ( mixed $value ): bool => null !== $value );
	$header  = test_base64url_encode( (string) json_encode( array( 'alg' => 'RS256', 'kid' => 'primary' ), JSON_THROW_ON_ERROR ) );
	$payload = test_base64url_encode( (string) json_encode( $claims, JSON_THROW_ON_ERROR ) );

	$signature = '';
	if ( ! openssl_sign( $header . '.' . $payload, $signature, $private, OPENSSL_ALGO_SHA256 ) ) {
		throw new RuntimeException( 'Could not sign test token.' );
	}
	return $header . '.' . $payload . '.' . test_base64url_encode( $signature );
}

$key_pair = test_key_pair();
$cache_key = 'patronage_access_certs_' . substr( hash( 'sha256', PATRONAGE_ACCESS_TEAM_DOMAIN ), 0, 32 );
$test_transients[ $cache_key ] = array( 'primary' => $key_pair['certificate'] );
$_SERVER['HTTP_X_ACCESS_USER_JWT'] = test_token( $key_pair['private'] );

// WPGraphQL 2.17 first resolves our Access user, then treats that identity as
// cookie authentication because it carries no Authorization header or nonce.
// Its documented filter must preserve a successfully verified gateway user.
$resolved_user = Patronage_Access_REST_Auth::determine_current_user( false );
wp_set_current_user( is_int( $resolved_user ) ? $resolved_user : 0 );
$authentication_errors = apply_filters( 'graphql_authentication_errors', null, null );
if ( false !== $authentication_errors ) {
	wp_set_current_user( 0 );
}

// WPGraphQL then fires this action immediately before it constructs Request
// and its DisableIntrospection validation rule. The user must still be set.
do_action( 'graphql_process_http_request' );

if ( 42 !== get_current_user_id() ) {
	fwrite( STDERR, "GraphQL authentication did not run before validation rules were built.\n" );
	exit( 1 );
}

$response = apply_filters( 'rest_post_dispatch', new WP_REST_Response(), null, null );
if (
	! ( $response instanceof WP_REST_Response )
	|| '42' !== ( $response->headers['X-Access-WordPress-User-ID'] ?? null )
	|| 'person' !== ( $response->headers['X-Access-WordPress-User-Slug'] ?? null )
) {
	fwrite( STDERR, "Authenticated REST responses did not identify the mapped WordPress user.\n" );
	exit( 1 );
}

// ---------------------------------------------------------------------------
// Origin guard. A request reaching the origin must carry a valid
// Cf-Access-Jwt-Assertion; a service token is enough because the guard only
// proves the request came through Access.
// ---------------------------------------------------------------------------

$origin_code = static function (): ?string {
	$error = Patronage_Access_REST_Auth::check_origin();
	return null === $error ? null : $error->code;
};

unset( $_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] );
if ( 'patronage_access_origin_missing' !== $origin_code() ) {
	fwrite( STDERR, "Origin guard accepted a request without an Access assertion.\n" );
	exit( 1 );
}

$_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] = test_token( $key_pair['private'] );
if ( null !== $origin_code() ) {
	fwrite( STDERR, "Origin guard rejected a valid user assertion.\n" );
	exit( 1 );
}

$_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] = test_token(
	$key_pair['private'],
	array(
		'common_name' => 'client-id.access',
		'email'       => null,
	)
);
if ( null !== $origin_code() ) {
	fwrite( STDERR, "Origin guard rejected a valid service token assertion.\n" );
	exit( 1 );
}

$_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] = test_token( $key_pair['private'], array( 'aud' => 'another-application' ) );
if ( 'patronage_access_origin_invalid' !== $origin_code() ) {
	fwrite( STDERR, "Origin guard accepted an assertion for another application.\n" );
	exit( 1 );
}

$_SERVER['HTTP_CF_ACCESS_JWT_ASSERTION'] = 'forged.assertion.value';
if ( 'patronage_access_origin_invalid' !== $origin_code() ) {
	fwrite( STDERR, "Origin guard accepted a forged assertion.\n" );
	exit( 1 );
}

fwrite( STDOUT, "Early GraphQL authentication and origin guard tests passed.\n" );
