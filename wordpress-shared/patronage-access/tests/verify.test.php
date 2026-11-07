<?php

declare(strict_types=1);

define( 'PATRONAGE_ACCESS_TESTING', true );
require_once dirname( __DIR__ ) . '/patronage-access.php';

/**
 * @return array{private:OpenSSLAsymmetricKey,certificate:string}
 */
function create_key_pair(): array {
	$private_key = openssl_pkey_new(
		array(
			'private_key_bits' => 2048,
			'private_key_type' => OPENSSL_KEYTYPE_RSA,
		)
	);
	if ( false === $private_key ) {
		throw new RuntimeException( 'Could not create RSA key.' );
	}

	$csr = openssl_csr_new( array( 'commonName' => 'access.test' ), $private_key );
	if ( false === $csr ) {
		throw new RuntimeException( 'Could not create certificate request.' );
	}

	$certificate_resource = openssl_csr_sign( $csr, null, $private_key, 1 );
	if ( false === $certificate_resource ) {
		throw new RuntimeException( 'Could not self-sign certificate.' );
	}

	$certificate = '';
	if ( ! openssl_x509_export( $certificate_resource, $certificate ) ) {
		throw new RuntimeException( 'Could not export certificate.' );
	}

	return array(
		'certificate' => $certificate,
		'private'     => $private_key,
	);
}

function base64url_encode( string $value ): string {
	return rtrim( strtr( base64_encode( $value ), '+/', '-_' ), '=' );
}

/**
 * @param array<string,mixed> $header
 * @param array<string,mixed> $claims
 */
function mint_token( array $header, array $claims, OpenSSLAsymmetricKey $private_key ): string {
	$encoded_header = base64url_encode( (string) json_encode( $header, JSON_THROW_ON_ERROR ) );
	$encoded_claims = base64url_encode( (string) json_encode( $claims, JSON_THROW_ON_ERROR ) );
	$signing_input  = $encoded_header . '.' . $encoded_claims;
	$signature      = '';
	if ( ! openssl_sign( $signing_input, $signature, $private_key, OPENSSL_ALGO_SHA256 ) ) {
		throw new RuntimeException( 'Could not sign token.' );
	}
	return $signing_input . '.' . base64url_encode( $signature );
}

/**
 * @param mixed $expected
 * @param mixed $actual
 */
function assert_same( mixed $expected, mixed $actual, string $name ): void {
	if ( $expected !== $actual ) {
		fwrite(
			STDERR,
			$name . " failed. Expected " . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . ".\n"
		);
		exit( 1 );
	}
}

/**
 * @param array<string,mixed>|string $result
 */
function result_kind( array|string $result ): string {
	return is_array( $result ) ? 'valid' : $result;
}

$now       = 1_800_000_000;
$issuer    = 'https://team.cloudflareaccess.com';
$audience  = 'gateway-application-aud';
$key_pair  = create_key_pair();
$other_key = create_key_pair();
$header    = array(
	'alg' => 'RS256',
	'kid' => 'primary',
	'typ' => 'JWT',
);
$claims    = array(
	'aud'   => $audience,
	'email' => 'person@example.com',
	'exp'   => $now + 300,
	'iss'   => $issuer,
	'nbf'   => $now - 10,
	'sub'   => 'opaque-access-subject',
);
$certs     = array( 'primary' => $key_pair['certificate'] );

$verify = static function ( string $token, ?string $expected_issuer = null, ?array $expected_audiences = null ) use ( $certs, $issuer, $audience, $now ): array|string {
	return Patronage_Access_JWT_Verifier::verify(
		$token,
		$certs,
		$expected_issuer ?? $issuer,
		$expected_audiences ?? array( $audience ),
		$now
	);
};

assert_same( 'valid', result_kind( $verify( mint_token( $header, $claims, $key_pair['private'] ) ) ), 'valid token' );

$wrong_audience        = $claims;
$wrong_audience['aud'] = 'other-application';
assert_same( 'audience', result_kind( $verify( mint_token( $header, $wrong_audience, $key_pair['private'] ) ) ), 'wrong audience' );

$audience_array        = $claims;
$audience_array['aud'] = array( 'other-application', $audience );
assert_same( 'valid', result_kind( $verify( mint_token( $header, $audience_array, $key_pair['private'] ) ) ), 'audience array' );

$wrong_issuer        = $claims;
$wrong_issuer['iss'] = 'https://other.cloudflareaccess.com';
assert_same( 'issuer', result_kind( $verify( mint_token( $header, $wrong_issuer, $key_pair['private'] ) ) ), 'wrong issuer' );
assert_same( 'issuer', result_kind( $verify( mint_token( $header, $claims, $key_pair['private'] ), $issuer . '/' ) ), 'issuer trailing slash mismatch' );

$expired        = $claims;
$expired['exp'] = $now - 61;
assert_same( 'expired', result_kind( $verify( mint_token( $header, $expired, $key_pair['private'] ) ) ), 'expiry beyond leeway' );
$within_leeway        = $claims;
$within_leeway['exp'] = $now - 60;
assert_same( 'valid', result_kind( $verify( mint_token( $header, $within_leeway, $key_pair['private'] ) ) ), 'expiry within leeway' );

$future_nbf        = $claims;
$future_nbf['nbf'] = $now + 61;
assert_same( 'not_yet_valid', result_kind( $verify( mint_token( $header, $future_nbf, $key_pair['private'] ) ) ), 'future nbf' );

assert_same( 'signature', result_kind( $verify( mint_token( $header, $claims, $other_key['private'] ) ) ), 'other signing key' );

$none_header        = $header;
$none_header['alg'] = 'none';
assert_same( 'alg', result_kind( $verify( mint_token( $none_header, $claims, $key_pair['private'] ) ) ), 'alg none' );
$hs_header        = $header;
$hs_header['alg'] = 'HS256';
assert_same( 'alg', result_kind( $verify( mint_token( $hs_header, $claims, $key_pair['private'] ) ) ), 'alg HS256' );

$missing_kid = $header;
unset( $missing_kid['kid'] );
assert_same( 'unknown_kid', result_kind( $verify( mint_token( $missing_kid, $claims, $key_pair['private'] ) ) ), 'missing kid' );
$unknown_kid        = $header;
$unknown_kid['kid'] = 'rotated';
assert_same( 'unknown_kid', result_kind( $verify( mint_token( $unknown_kid, $claims, $key_pair['private'] ) ) ), 'unknown kid' );

$service_token = $claims;
unset( $service_token['email'] );
assert_same( 'no_email', result_kind( $verify( mint_token( $header, $service_token, $key_pair['private'] ) ) ), 'service token' );
assert_same(
	'valid',
	result_kind( Patronage_Access_JWT_Verifier::verify( mint_token( $header, $service_token, $key_pair['private'] ), $certs, $issuer, array( $audience ), $now, false ) ),
	'service token passes when no email is required'
);
$invalid_email          = $claims;
$invalid_email['email'] = 'not-an-email';
assert_same( 'no_email', result_kind( $verify( mint_token( $header, $invalid_email, $key_pair['private'] ) ) ), 'invalid email' );

foreach ( array( '', 'one', 'one.two', 'one.two.three.four', '***.two.three' ) as $index => $malformed ) {
	assert_same( 'malformed', result_kind( $verify( $malformed ) ), 'malformed token ' . $index );
}

$valid_token     = mint_token( $header, $claims, $key_pair['private'] );
$parts           = explode( '.', $valid_token );
$tampered_claims = $claims;
$tampered_claims['email'] = 'attacker@example.com';
$parts[1]        = base64url_encode( (string) json_encode( $tampered_claims, JSON_THROW_ON_ERROR ) );
assert_same( 'signature', result_kind( $verify( implode( '.', $parts ) ) ), 'tampered payload' );

assert_same(
	'bad_cert',
	result_kind( Patronage_Access_JWT_Verifier::verify( $valid_token, array( 'primary' => 'not a certificate' ), $issuer, array( $audience ), $now ) ),
	'invalid certificate'
);

// ---------------------------------------------------------------------------
// Gateway proof verification. The known-answer vector is shared verbatim with
// the Worker suite (worker/src/wordpress.test.ts) so the two implementations
// cannot drift: secret "proof-test-secret", jwt "aaa.bbb.ccc", t=1700000000.
// ---------------------------------------------------------------------------

$proof_secret = 'proof-test-secret';
$proof_jwt    = 'aaa.bbb.ccc';
$proof_now    = 1700000000;
$known_proof  = 't=1700000000,v1=1c8f01bed0503f0d5e251595bb5d22c4139dbf1db58b43f63c5d8463d26aa227';

$verify_proof = static fn ( string $proof, int $at = 1700000000, string $jwt = 'aaa.bbb.ccc', string $secret = 'proof-test-secret' ): bool|string =>
	Patronage_Access_JWT_Verifier::verify_gateway_proof( $proof, $jwt, $secret, $at );

assert_same( true, $verify_proof( $known_proof ), 'known-answer proof' );
assert_same( true, $verify_proof( $known_proof, $proof_now + 300 ), 'proof at skew boundary' );
assert_same( 'stale_proof', $verify_proof( $known_proof, $proof_now + 301 ), 'proof past skew' );
assert_same( 'stale_proof', $verify_proof( $known_proof, $proof_now - 301 ), 'proof from the future' );
assert_same( 'proof_signature', $verify_proof( $known_proof, $proof_now, 'other.jwt.value' ), 'proof bound to different token' );
assert_same( 'proof_signature', $verify_proof( $known_proof, $proof_now, $proof_jwt, 'wrong-secret' ), 'proof with wrong secret' );

foreach ( array(
	'',
	't=1700000000',
	'v1=1c8f01bed0503f0d5e251595bb5d22c4139dbf1db58b43f63c5d8463d26aa227',
	't=1700000000,v1=SHORT',
	't=1700000000,v1=' . strtoupper( '1c8f01bed0503f0d5e251595bb5d22c4139dbf1db58b43f63c5d8463d26aa227' ),
	't=-1,v1=1c8f01bed0503f0d5e251595bb5d22c4139dbf1db58b43f63c5d8463d26aa227',
) as $index => $malformed_proof ) {
	assert_same( 'malformed_proof', $verify_proof( $malformed_proof ), 'malformed proof ' . $index );
}

// ---------------------------------------------------------------------------
// Authentication precedence. A gateway request is authenticated from its JWT
// no matter which authenticator ran first; a request without the header leaves
// cookies and application passwords alone.
// ---------------------------------------------------------------------------

$decides = static fn ( bool $is_authenticatable, string $token ): bool =>
	Patronage_Access_JWT_Verifier::gateway_identity_decides( $is_authenticatable, $token );

assert_same( true, $decides( true, 'header.payload.signature' ), 'gateway header decides a REST request' );
assert_same( false, $decides( true, '' ), 'absent header leaves the earlier user' );
assert_same( false, $decides( false, 'header.payload.signature' ), 'header ignored outside REST and WPGraphQL' );
assert_same( false, $decides( false, '' ), 'no header outside REST and WPGraphQL' );

// ---------------------------------------------------------------------------
// Origin guard scope: every HTTP request when enabled, never the command line.
// ---------------------------------------------------------------------------

$applies = static fn ( bool $enabled, string $sapi, bool $is_wp_cli ): bool =>
	Patronage_Access_JWT_Verifier::origin_guard_applies( $enabled, $sapi, $is_wp_cli );

assert_same( true, $applies( true, 'fpm-fcgi', false ), 'guard checks web requests' );
assert_same( false, $applies( false, 'fpm-fcgi', false ), 'guard off by default' );
assert_same( false, $applies( true, 'cli', false ), 'guard skips the command line' );
assert_same( false, $applies( true, 'fpm-fcgi', true ), 'guard skips WP-CLI' );

// ---------------------------------------------------------------------------
// Browser login steps: a plain GET of the login screen probes once with the
// guard cookie, then signs in only if the cookie came back.
// ---------------------------------------------------------------------------

$login_step = static fn ( array $query, bool $guard = false, string $method = 'GET', bool $logged_in = false, bool $enabled = true ): string =>
	Patronage_Access_JWT_Verifier::browser_login_step( $enabled, $method, $query, $logged_in, $guard );

$marked = array( 'patronage_access_login' => '1' );
assert_same( 'probe', $login_step( array() ), 'login screen probes' );
assert_same( 'probe', $login_step( array( 'action' => 'login' ) ), 'explicit login action probes' );
assert_same( 'probe', $login_step( array( 'redirect_to' => 'https://cms.example.com/wp-admin/', 'reauth' => '1' ) ), 'redirect from wp-admin probes' );
assert_same( 'login', $login_step( $marked, true ), 'guard cookie came back' );
assert_same( 'skip', $login_step( $marked, false ), 'browser refused the guard cookie' );
assert_same( 'skip', $login_step( array(), true ), 'sent back after a sign-in' );
assert_same( 'skip', $login_step( array(), false, 'GET', false, false ), 'browser login off by default' );
assert_same( 'skip', $login_step( $marked, true, 'POST' ), 'form post' );
assert_same( 'skip', $login_step( array(), false, 'GET', true ), 'already signed in' );
assert_same( 'skip', $login_step( array( 'loggedout' => 'true' ) ), 'after logout' );
assert_same( 'skip', $login_step( array( 'action' => 'logout' ) ), 'logout action' );
assert_same( 'skip', $login_step( array( 'action' => 'lostpassword' ) ), 'lost password' );
assert_same( 'skip', $login_step( array( 'action' => array( 'login' ) ) ), 'array action' );
assert_same( 'skip', $login_step( array( 'interim-login' => '1' ) ), 'session-expired modal' );
assert_same( 'skip', $login_step( array( 'patronage_access_login' => 'off' ) ), 'opt out once' );
assert_same( 'skip', $login_step( array( 'patronage_access_login' => array( '1' ) ), true ), 'array marker' );

fwrite( STDOUT, "Access JWT verifier tests passed.\n" );
