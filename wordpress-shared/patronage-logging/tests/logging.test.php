<?php

declare(strict_types=1);

define( 'PATRONAGE_LOGGING_TESTING', true );
require_once dirname( __DIR__ ) . '/patronage-logging.php';

$failures = 0;

function check( bool $condition, string $message ): void {
	global $failures;
	if ( ! $condition ) {
		++$failures;
		fwrite( STDERR, "FAIL: {$message}\n" );
	}
}

function temp_dir(): string {
	$dir = sys_get_temp_dir() . '/patronage-logging-test-' . bin2hex( random_bytes( 4 ) );
	mkdir( $dir, 0700, true );
	return $dir;
}

/**
 * @param list<string> $files
 */
function config( string $dir, array $files = array() ): Patronage_Logging_Config {
	return new Patronage_Logging_Config( 'https://stream.example/ingest', 'token', $dir . '/spool', 'demo.example', $files, false );
}

// Request context: no query strings, the right kind, Cloudflare's client IP.
$context = Patronage_Logging_Recorder::request_context(
	array(
		'HTTP_CF_CONNECTING_IP' => '203.0.113.9',
		'HTTP_CF_RAY'           => 'abc123-DFW',
		'REMOTE_ADDR'           => '10.0.0.1',
		'REQUEST_METHOD'        => 'post',
		'REQUEST_URI'           => '/wp-login.php?redirect_to=%2Fwp-admin%2F&secret=1',
	)
);
check( '/wp-login.php' === $context['path'], 'path keeps no query string' );
check( 'login' === $context['kind'], 'wp-login.php is a login request' );
check( 'POST' === $context['method'], 'method is upper-cased' );
check( '203.0.113.9' === $context['ip'], 'CF-Connecting-IP wins over REMOTE_ADDR' );
check( 'ajax' === Patronage_Logging_Recorder::kind( '/wp-admin/admin-ajax.php' ), 'admin-ajax is ajax' );
check( 'graphql' === Patronage_Logging_Recorder::kind( '/graphql' ), 'graphql kind' );
check( 'rest' === Patronage_Logging_Recorder::kind( '/wp-json/wp/v2/posts' ), 'rest kind' );

// Which requests are kept.
$read = array( 'kind' => 'graphql', 'method' => 'GET' );
check( ! Patronage_Logging_Recorder::worth_keeping( $read, 200, 0, 0 ), 'anonymous GraphQL reads are skipped' );
check( Patronage_Logging_Recorder::worth_keeping( $read, 500, 0, 0 ), 'server errors are kept' );
check( Patronage_Logging_Recorder::worth_keeping( $read, 200, 0, 1 ), 'requests with actions are kept' );
check( Patronage_Logging_Recorder::worth_keeping( array( 'kind' => 'rest', 'method' => 'POST' ), 200, 0, 0 ), 'REST writes are kept' );
check( Patronage_Logging_Recorder::worth_keeping( array( 'kind' => 'admin', 'method' => 'GET' ), 200, 3, 0 ), 'signed-in admin views are kept' );
check( ! Patronage_Logging_Recorder::worth_keeping( array( 'kind' => 'admin', 'method' => 'GET' ), 200, 0, 0 ), 'anonymous admin redirects are skipped' );
check( ! Patronage_Logging_Recorder::worth_keeping( array( 'kind' => 'front', 'method' => 'POST' ), 200, 0, 0 ), 'front-end posts without actions are skipped' );

// Spool: guarded file, claim moves it aside, read skips the guard.
$dir   = temp_dir();
$spool = new Patronage_Logging_Spool( $dir . '/spool' );
check( $spool->append( array( 'n' => 1 ) ), 'append writes' );
check( $spool->append( array( 'n' => 2 ) ), 'append writes again' );
$raw = (string) file_get_contents( $dir . '/spool/spool.php' );
check( str_starts_with( $raw, '<?php exit; ?>' ), 'spool starts with an exit guard' );
check( 1 === substr_count( $raw, '<?php' ), 'guard is written once' );
$claimed = $spool->claim();
check( 1 === count( $claimed ) && ! file_exists( $dir . '/spool/spool.php' ), 'claim moves the live spool aside' );
check( array( array( 'n' => 1 ), array( 'n' => 2 ) ) === Patronage_Logging_Spool::read( $claimed[0] ), 'read returns the records' );

// Shipper: sends spooled events, keeps them when sending fails.
$sent    = array();
$working = static function ( string $endpoint, string $body ) use ( &$sent ): bool {
	$sent[] = json_decode( $body, true );
	return true;
};
$failing = static fn (): bool => false;

$dir   = temp_dir();
$cfg   = config( $dir );
$spool = new Patronage_Logging_Spool( $cfg->spool_dir );
$spool->append( array( 'type' => 'a' ) );

$result = ( new Patronage_Logging_Shipper( $cfg, $failing ) )->run();
check( 0 === $result['events'] && 1 === count( $result['errors'] ), 'a failed send reports an error' );
check( 1 === count( glob( $cfg->spool_dir . '/claimed-*.php' ) ?: array() ), 'a failed send keeps the claimed file' );

$spool->append( array( 'type' => 'b' ) );
$result = ( new Patronage_Logging_Shipper( $cfg, $working ) )->run();
check( 2 === $result['events'], 'the retry sends the old and new events' );
check( array() === ( glob( $cfg->spool_dir . '/claimed-*.php' ) ?: array() ), 'sent files are removed' );
check( 'a' === ( $sent[0][0]['type'] ?? null ) && 'b' === ( $sent[1][0]['type'] ?? null ), 'oldest file goes first' );

// Log files: only complete new lines, offsets kept, rotation restarts.
$sent = array();
$dir  = temp_dir();
$log  = $dir . '/app.access.log';
file_put_contents( $log, "one\ntwo\npartial" );
$cfg     = config( $dir, array( $dir . '/*.log' ) );
$shipper = new Patronage_Logging_Shipper( $cfg, $working );

$result = $shipper->run();
check( 2 === $result['lines'], 'ships complete lines only' );
check( 'one' === ( $sent[0][0]['line'] ?? null ) && 'wordpress-server' === ( $sent[0][0]['source'] ?? null ), 'line records carry source and text' );

file_put_contents( $log, " line\nthree\n", FILE_APPEND );
$sent   = array();
$result = $shipper->run();
check( 2 === $result['lines'] && 'partial line' === ( $sent[0][0]['line'] ?? null ), 'resumes from the saved offset' );

check( 0 === $shipper->run()['lines'], 'nothing new, nothing sent' );

unlink( $log );
file_put_contents( $log, "rotated\n" );
$sent   = array();
$result = $shipper->run();
check( 1 === $result['lines'] && 'rotated' === ( $sent[0][0]['line'] ?? null ), 'a rotated file starts again' );

$before = (string) file_get_contents( $cfg->spool_dir . '/files.json' );
file_put_contents( $log, "four\n", FILE_APPEND );
( new Patronage_Logging_Shipper( $cfg, $failing ) )->run();
check( $before === (string) file_get_contents( $cfg->spool_dir . '/files.json' ), 'a failed send keeps the old offset' );

if ( $failures > 0 ) {
	exit( 1 );
}

echo "logging.test.php: ok\n";
