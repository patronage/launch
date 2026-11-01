<?php
// With no endpoint or token, loading the plugin must register nothing.

declare(strict_types=1);

define( 'ABSPATH', sys_get_temp_dir() . '/patronage-logging-off/' );

$hooks = 0;

function add_action(): void {
	global $hooks;
	++$hooks;
}

function add_filter(): void {
	global $hooks;
	++$hooks;
}

require dirname( __DIR__ ) . '/patronage-logging.php';

if ( 0 !== $hooks ) {
	fwrite( STDERR, "FAIL: unconfigured plugin registered {$hooks} hooks\n" );
	exit( 1 );
}

if ( null !== Patronage_Logging_Config::from_constants() ) {
	fwrite( STDERR, "FAIL: config without constants should be null\n" );
	exit( 1 );
}

echo "off.test.php: ok\n";
