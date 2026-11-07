<?php
// The health route is public, uncached, and fails with 503 when the database
// does not answer. Reporting stays off without production and its constants.

declare(strict_types=1);

define( 'ABSPATH', sys_get_temp_dir() . '/patronage-fleet-test/' );

$actions = array();
$routes  = array();

function add_action( string $hook, callable $callback ): void {
	global $actions;
	$actions[ $hook ][] = $callback;
}

function register_rest_route( string $namespace, string $route, array $args ): void {
	global $routes;
	$routes[ $namespace . $route ] = $args;
}

function __return_true(): bool {
	return true;
}

function wp_get_environment_type(): string {
	return 'production';
}

class WP_REST_Response {
	public array $headers = array();

	public function __construct( public mixed $data, public int $status ) {}

	public function header( string $name, string $value ): void {
		$this->headers[ $name ] = $value;
	}
}

class Fake_DB {
	public bool $up = true;

	public function suppress_errors( bool $suppress ): bool {
		return false;
	}

	public function get_var( string $query ): ?string {
		return $this->up ? '1' : null;
	}
}

$wpdb = new Fake_DB();

require dirname( __DIR__ ) . '/patronage-fleet.php';

function check( bool $ok, string $message ): void {
	if ( ! $ok ) {
		fwrite( STDERR, "FAIL: {$message}\n" );
		exit( 1 );
	}
}

foreach ( $actions['rest_api_init'] ?? array() as $callback ) {
	$callback();
}
$route = $routes['patronage-fleet/v1/health'] ?? null;
check( is_array( $route ) && 'GET' === $route['methods'], 'health route is registered for GET' );
check( true === ( $route['permission_callback'] )(), 'health route is public' );

$up = ( $route['callback'] )();
check( 200 === $up->status && array( 'status' => 'ok' ) === $up->data, 'healthy site answers 200 {"status":"ok"}' );
check( str_contains( $up->headers['Cache-Control'] ?? '', 'no-store' ), 'health response is not cacheable' );

$wpdb->up = false;
$down     = ( $route['callback'] )();
check( 503 === $down->status && 'ok' !== $down->data['status'], 'database failure answers 503' );

check( false === patronage_fleet_configured(), 'reporting is off without the PATRONAGE_FLEET_* constants' );

echo "health.test.php: ok\n";
