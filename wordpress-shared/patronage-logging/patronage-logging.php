<?php
/**
 * Plugin Name: Patronage Logging
 * Description: Records security-relevant WordPress events as wide events and ships them, with the host's log files, to a Basin Pipelines stream. Does nothing unless configured.
 * Version: 0.1.0
 * License: MIT
 */

declare(strict_types=1);

if ( ! defined( 'ABSPATH' ) && ! defined( 'PATRONAGE_LOGGING_TESTING' ) ) {
	exit;
}

/**
 * Settings, read from constants. Logging is on only when both the endpoint and
 * the token are set; everything else has a default.
 */
final class Patronage_Logging_Config {
	public function __construct(
		public readonly string $endpoint,
		public readonly string $token,
		public readonly string $spool_dir,
		public readonly string $site,
		/** @var list<string> */
		public readonly array $files,
		public readonly bool $wp_cron,
	) {}

	public static function from_constants(): ?self {
		$endpoint = defined( 'PATRONAGE_LOGGING_ENDPOINT' ) ? (string) PATRONAGE_LOGGING_ENDPOINT : '';
		$token    = defined( 'PATRONAGE_LOGGING_TOKEN' ) ? (string) PATRONAGE_LOGGING_TOKEN : '';

		if ( '' === $endpoint || '' === $token ) {
			return null;
		}

		$files = defined( 'PATRONAGE_LOGGING_FILES' ) ? PATRONAGE_LOGGING_FILES : array();

		return new self(
			$endpoint,
			$token,
			defined( 'PATRONAGE_LOGGING_SPOOL_DIR' ) ? rtrim( (string) PATRONAGE_LOGGING_SPOOL_DIR, '/' ) : self::default_spool_dir(),
			defined( 'PATRONAGE_LOGGING_SITE' ) ? (string) PATRONAGE_LOGGING_SITE : self::default_site(),
			array_values( array_map( 'strval', is_array( $files ) ? $files : array( $files ) ) ),
			defined( 'PATRONAGE_LOGGING_WP_CRON' ) && true === PATRONAGE_LOGGING_WP_CRON,
		);
	}

	/**
	 * Outside the web root when the host has a private folder beside it, as
	 * Cloudways does (`private_html`); otherwise the system temp folder.
	 */
	private static function default_spool_dir(): string {
		$root    = defined( 'ABSPATH' ) ? dirname( rtrim( (string) ABSPATH, '/' ) ) : sys_get_temp_dir();
		$private = $root . '/private_html';

		if ( is_dir( $private ) && is_writable( $private ) ) {
			return $private . '/patronage-logging';
		}

		// One folder per install, so sites that share a server never share a spool.
		return rtrim( sys_get_temp_dir(), '/' ) . '/patronage-logging-' . substr( hash( 'sha256', $root ), 0, 12 );
	}

	private static function default_site(): string {
		if ( function_exists( 'home_url' ) ) {
			$host = wp_parse_url( home_url(), PHP_URL_HOST );
			if ( is_string( $host ) && '' !== $host ) {
				return $host;
			}
		}
		return 'wordpress';
	}
}

/**
 * Newline-delimited JSON on disk, so a request never waits on the network.
 * Files end in .php and start with an exit line, so a web server that can
 * reach the folder runs them instead of serving them.
 */
final class Patronage_Logging_Spool {
	private const GUARD = "<?php exit; ?>\n";

	public function __construct( private readonly string $dir ) {}

	public function dir(): string {
		return $this->dir;
	}

	private function ensure_dir(): bool {
		if ( is_dir( $this->dir ) ) {
			return true;
		}
		return @mkdir( $this->dir, 0700, true ) || is_dir( $this->dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
	}

	/**
	 * @param array<string,mixed> $record
	 */
	public function append( array $record ): bool {
		if ( ! $this->ensure_dir() ) {
			return false;
		}

		$lock = $this->lock( LOCK_SH );
		if ( null === $lock ) {
			return false;
		}

		$path  = $this->dir . '/spool.php';
		$line  = json_encode( $record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE );
		$guard = file_exists( $path ) ? '' : self::GUARD;

		$written = false !== $line
			&& false !== @file_put_contents( $path, $guard . $line . "\n", FILE_APPEND | LOCK_EX ); // phpcs:ignore WordPress.PHP.NoSilencedErrors

		self::unlock( $lock );
		return $written;
	}

	/**
	 * Writers hold the spool lock shared and the shipper holds it exclusive
	 * while it moves the live file aside, so no request can still be writing
	 * to a file the shipper has claimed.
	 *
	 * @return resource|null
	 */
	private function lock( int $mode ) {
		if ( ! $this->ensure_dir() ) {
			return null;
		}
		$handle = @fopen( $this->dir . '/spool.lock', 'c' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		if ( false === $handle ) {
			return null;
		}
		if ( ! flock( $handle, $mode ) ) {
			fclose( $handle );
			return null;
		}
		return $handle;
	}

	/** @param resource $handle */
	private static function unlock( $handle ): void {
		flock( $handle, LOCK_UN );
		fclose( $handle );
	}

	/**
	 * Move the live spool aside so new events start a fresh file, and return
	 * every claimed file, oldest first, including any a failed run left.
	 *
	 * @return list<string>
	 */
	public function claim(): array {
		$live = $this->dir . '/spool.php';
		$lock = $this->lock( LOCK_EX );
		clearstatcache( true, $live );
		if ( null !== $lock && file_exists( $live ) && filesize( $live ) > strlen( self::GUARD ) ) {
			@rename( $live, sprintf( '%s/claimed-%016d-%s.php', $this->dir, (int) ( microtime( true ) * 1000000 ), bin2hex( random_bytes( 4 ) ) ) ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		}
		if ( null !== $lock ) {
			self::unlock( $lock );
		}

		$claimed = glob( $this->dir . '/claimed-*.php' );
		if ( false === $claimed ) {
			return array();
		}
		sort( $claimed );
		return array_values( $claimed );
	}

	/**
	 * @return list<array<string,mixed>>
	 */
	public static function read( string $path ): array {
		$records = array();
		$handle  = @fopen( $path, 'rb' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		if ( false === $handle ) {
			return $records;
		}
		while ( false !== ( $line = fgets( $handle ) ) ) {
			$line = trim( $line );
			if ( '' === $line || str_starts_with( $line, '<?php' ) ) {
				continue;
			}
			$record = json_decode( $line, true );
			if ( is_array( $record ) ) {
				$records[] = $record;
			}
		}
		fclose( $handle );
		return $records;
	}
}

/**
 * Collects what happened during one request and writes it as one wide event
 * at shutdown, when anything worth keeping happened.
 */
final class Patronage_Logging_Recorder {
	/** Options whose change is worth a record. */
	public const WATCHED_OPTIONS = array(
		'admin_email',
		'default_role',
		'home',
		'siteurl',
		'users_can_register',
	);

	private const MAX_ACTIONS = 50;

	/** @var list<array<string,mixed>> */
	private static array $actions = array();
	private static int $dropped   = 0;
	private static float $started = 0.0;
	private static ?Patronage_Logging_Config $config = null;

	public static function register( Patronage_Logging_Config $config ): void {
		self::$config  = $config;
		self::$started = isset( $_SERVER['REQUEST_TIME_FLOAT'] ) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime( true );

		add_action( 'wp_login', array( self::class, 'on_login' ), 10, 2 );
		add_action( 'wp_login_failed', array( self::class, 'on_login_failed' ), 10, 1 );
		add_action( 'wp_logout', array( self::class, 'on_logout' ), 10, 1 );
		add_action( 'user_register', array( self::class, 'on_user_register' ), 10, 1 );
		add_action( 'delete_user', array( self::class, 'on_delete_user' ), 10, 1 );
		add_action( 'set_user_role', array( self::class, 'on_set_user_role' ), 10, 3 );
		add_action( 'activated_plugin', array( self::class, 'on_plugin' ), 10, 1 );
		add_action( 'deactivated_plugin', array( self::class, 'on_plugin_deactivated' ), 10, 1 );
		add_action( 'deleted_plugin', array( self::class, 'on_plugin_deleted' ), 10, 1 );
		add_action( 'switch_theme', array( self::class, 'on_switch_theme' ), 10, 1 );
		add_action( 'upgrader_process_complete', array( self::class, 'on_upgrade' ), 10, 2 );
		add_action( 'updated_option', array( self::class, 'on_updated_option' ), 10, 1 );
		add_action( 'wp_create_application_password', array( self::class, 'on_app_password_created' ), 10, 2 );
		add_action( 'wp_delete_application_password', array( self::class, 'on_app_password_deleted' ), 10, 2 );
		add_action( 'application_password_did_authenticate', array( self::class, 'on_app_password_used' ), 10, 2 );
		add_action( 'transition_post_status', array( self::class, 'on_post_status' ), 10, 3 );
		add_action( 'do_graphql_request', array( self::class, 'on_graphql_request' ), 10, 2 );
		add_action( 'shutdown', array( self::class, 'flush' ), 1000 );
	}

	/**
	 * @param array<string,mixed> $fields
	 */
	public static function record( string $type, array $fields = array() ): void {
		if ( count( self::$actions ) >= self::MAX_ACTIONS ) {
			++self::$dropped;
			return;
		}
		self::$actions[] = array( 'type' => $type ) + $fields;
	}

	/** @param mixed $user */
	public static function on_login( string $login, $user = null ): void {
		self::record( 'login.success', array( 'userId' => self::user_id( $user ) ) );
	}

	/** @param mixed $username */
	public static function on_login_failed( $username ): void {
		self::record( 'login.failed', array( 'username' => self::login_identifier( is_string( $username ) ? $username : '' ) ) );
	}

	public static function on_logout( int $user_id = 0 ): void {
		self::record( 'logout', array( 'userId' => $user_id ) );
	}

	public static function on_user_register( int $user_id ): void {
		self::record( 'user.created', array( 'userId' => $user_id ) );
	}

	public static function on_delete_user( int $user_id ): void {
		self::record( 'user.deleted', array( 'userId' => $user_id ) );
	}

	/**
	 * @param array<int,string> $old_roles
	 */
	public static function on_set_user_role( int $user_id, string $role, array $old_roles = array() ): void {
		self::record(
			'user.role_changed',
			array(
				'from'   => array_values( $old_roles ),
				'to'     => $role,
				'userId' => $user_id,
			)
		);
	}

	public static function on_plugin( string $plugin ): void {
		self::record( 'plugin.activated', array( 'plugin' => $plugin ) );
	}

	public static function on_plugin_deactivated( string $plugin ): void {
		self::record( 'plugin.deactivated', array( 'plugin' => $plugin ) );
	}

	public static function on_plugin_deleted( string $plugin ): void {
		self::record( 'plugin.deleted', array( 'plugin' => $plugin ) );
	}

	public static function on_switch_theme( string $name ): void {
		self::record( 'theme.switched', array( 'theme' => $name ) );
	}

	/**
	 * @param mixed               $upgrader
	 * @param array<string,mixed> $extra
	 */
	public static function on_upgrade( $upgrader, array $extra = array() ): void {
		$items = array();
		foreach ( array( 'plugins', 'themes' ) as $key ) {
			if ( isset( $extra[ $key ] ) && is_array( $extra[ $key ] ) ) {
				$items = array_merge( $items, array_map( 'strval', $extra[ $key ] ) );
			}
		}
		self::record(
			'code.updated',
			array(
				'action' => isset( $extra['action'] ) ? (string) $extra['action'] : '',
				'items'  => array_slice( $items, 0, 20 ),
				'kind'   => isset( $extra['type'] ) ? (string) $extra['type'] : '',
			)
		);
	}

	public static function on_updated_option( string $option ): void {
		$watched = function_exists( 'apply_filters' )
			? (array) apply_filters( 'patronage_logging_watched_options', self::WATCHED_OPTIONS )
			: self::WATCHED_OPTIONS;
		if ( in_array( $option, $watched, true ) ) {
			self::record( 'option.updated', array( 'option' => $option ) );
		}
	}

	/** @param array<string,mixed> $item */
	public static function on_app_password_created( int $user_id, array $item = array() ): void {
		self::record( 'app_password.created', array( 'name' => self::item_name( $item ), 'userId' => $user_id ) );
	}

	/** @param array<string,mixed> $item */
	public static function on_app_password_deleted( int $user_id, array $item = array() ): void {
		self::record( 'app_password.deleted', array( 'name' => self::item_name( $item ), 'userId' => $user_id ) );
	}

	/**
	 * @param mixed               $user
	 * @param array<string,mixed> $item
	 */
	public static function on_app_password_used( $user, array $item = array() ): void {
		self::record( 'app_password.used', array( 'name' => self::item_name( $item ), 'userId' => self::user_id( $user ) ) );
	}

	/** @param mixed $post */
	public static function on_post_status( string $new_status, string $old_status, $post ): void {
		if ( $new_status === $old_status || 'auto-draft' === $new_status || 'inherit' === $new_status ) {
			return;
		}
		self::record(
			'content.status',
			array(
				'from'     => $old_status,
				'postId'   => is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0,
				'postType' => is_object( $post ) && isset( $post->post_type ) ? (string) $post->post_type : '',
				'to'       => $new_status,
			)
		);
	}

	/**
	 * WPGraphQL reads arrive as POST too, so a GraphQL request counts as a
	 * write only when its operation is a mutation.
	 *
	 * @param mixed $query
	 * @param mixed $operation
	 */
	public static function on_graphql_request( $query, $operation = null ): void {
		if ( is_string( $query ) && self::is_mutation( $query ) ) {
			self::record( 'graphql.mutation', array( 'operation' => is_string( $operation ) ? substr( $operation, 0, 100 ) : '' ) );
		}
	}

	public static function is_mutation( string $query ): bool {
		$without_comments = (string) preg_replace( '/#[^\n]*/', '', $query );
		return 1 === preg_match( '/(?:^|\})\s*mutation\b/i', $without_comments );
	}

	public static function flush(): void {
		if ( null === self::$config ) {
			return;
		}

		$request = self::request_context( $_SERVER );
		$status  = http_response_code();
		$status  = is_int( $status ) ? $status : 200;
		$user_id = function_exists( 'get_current_user_id' ) ? (int) get_current_user_id() : 0;

		if ( ! self::worth_keeping( $request, $status, $user_id, count( self::$actions ) ) ) {
			return;
		}

		$event = array(
			'actions'    => self::$actions,
			'durationMs' => (int) round( ( microtime( true ) - self::$started ) * 1000 ),
			'request'    => $request,
			'site'       => self::$config->site,
			'source'     => 'wordpress',
			'status'     => $status,
			'timestamp'  => gmdate( 'Y-m-d\TH:i:s.v\Z' ),
			'userId'     => $user_id,
		);
		if ( self::$dropped > 0 ) {
			$event['actionsDropped'] = self::$dropped;
		}

		( new Patronage_Logging_Spool( self::$config->spool_dir ) )->append( $event );
		self::$actions = array();
		self::$dropped = 0;
	}

	/**
	 * Keep requests that did something, wrote something, failed, or were a
	 * signed-in person in wp-admin. Skip the stream of anonymous reads (the
	 * headless front end's WPGraphQL queries), which Cloudflare's own logs cover.
	 *
	 * @param array<string,mixed> $request
	 */
	public static function worth_keeping( array $request, int $status, int $user_id, int $actions ): bool {
		if ( $actions > 0 || $status >= 500 ) {
			return true;
		}
		$write = ! in_array( $request['method'] ?? 'GET', array( 'GET', 'HEAD', 'OPTIONS' ), true );
		$kind  = $request['kind'] ?? 'front';
		// GraphQL writes are recorded as actions by on_graphql_request().
		if ( $write && in_array( $kind, array( 'admin', 'ajax', 'login', 'rest', 'xmlrpc' ), true ) ) {
			return true;
		}
		return 'admin' === $kind && $user_id > 0;
	}

	/**
	 * Method, kind and path without the query string, plus where it came from.
	 * No bodies, cookies or headers beyond these.
	 *
	 * @param array<string,mixed> $server
	 * @return array<string,mixed>
	 */
	public static function request_context( array $server ): array {
		$cli    = defined( 'WP_CLI' ) && WP_CLI;
		$uri    = isset( $server['REQUEST_URI'] ) ? (string) $server['REQUEST_URI'] : '';
		$path   = substr( (string) strtok( $uri, '?' ), 0, 200 );
		$method = $cli ? 'CLI' : strtoupper( isset( $server['REQUEST_METHOD'] ) ? (string) $server['REQUEST_METHOD'] : 'GET' );

		$context = array(
			'kind'   => $cli ? 'cli' : self::kind( $path ),
			'method' => $method,
			'path'   => $path,
		);

		$ip = $server['HTTP_CF_CONNECTING_IP'] ?? $server['REMOTE_ADDR'] ?? '';
		if ( is_string( $ip ) && '' !== $ip ) {
			$context['ip'] = $ip;
		}
		if ( isset( $server['HTTP_CF_RAY'] ) && is_string( $server['HTTP_CF_RAY'] ) ) {
			$context['cfRay'] = substr( $server['HTTP_CF_RAY'], 0, 64 );
		}
		if ( isset( $server['HTTP_USER_AGENT'] ) && is_string( $server['HTTP_USER_AGENT'] ) ) {
			$context['userAgent'] = substr( $server['HTTP_USER_AGENT'], 0, 200 );
		}
		return $context;
	}

	public static function kind( string $path ): string {
		return match ( true ) {
			str_contains( $path, '/wp-admin/admin-ajax.php' ) => 'ajax',
			str_contains( $path, '/wp-admin' ) => 'admin',
			str_contains( $path, '/wp-login.php' ) => 'login',
			str_contains( $path, '/wp-json' ) => 'rest',
			str_contains( $path, '/graphql' ) => 'graphql',
			str_contains( $path, '/xmlrpc.php' ) => 'xmlrpc',
			str_contains( $path, '/wp-cron.php' ) => 'cron',
			default => 'front',
		};
	}

	/**
	 * The name tried at login, kept so repeated attempts can be grouped. An
	 * email address is replaced by a short hash, because events hold no emails.
	 */
	public static function login_identifier( string $username ): string {
		$username = trim( $username );
		if ( str_contains( $username, '@' ) ) {
			return 'email-sha256:' . substr( hash( 'sha256', strtolower( $username ) ), 0, 16 );
		}
		return substr( $username, 0, 60 );
	}

	/** @param mixed $user */
	private static function user_id( $user ): int {
		return is_object( $user ) && isset( $user->ID ) ? (int) $user->ID : 0;
	}

	/** @param array<string,mixed> $item */
	private static function item_name( array $item ): string {
		return isset( $item['name'] ) ? substr( (string) $item['name'], 0, 60 ) : '';
	}
}

/**
 * Sends spooled events and new lines from the host's log files to the stream.
 * Runs from `wp patronage-logging ship` on a server cron, or from WP-Cron when
 * PATRONAGE_LOGGING_WP_CRON is true.
 */
final class Patronage_Logging_Shipper {
	private const BATCH_RECORDS   = 500;
	/** Basin takes requests up to 5 MB; stay well under it. */
	private const BATCH_BYTES     = 3 * 1024 * 1024;
	private const MAX_FILE_BYTES  = 5 * 1024 * 1024;
	private const MAX_LINE_LENGTH = 8192;

	/** @var callable(string,string):bool */
	private $send;

	/**
	 * @param callable(string,string):bool|null $send Posts a JSON body; true on success.
	 */
	public function __construct( private readonly Patronage_Logging_Config $config, ?callable $send = null ) {
		$this->send = $send ?? array( $this, 'post' );
	}

	/**
	 * @return array{events:int,lines:int,errors:list<string>}
	 */
	public function run(): array {
		$spool  = new Patronage_Logging_Spool( $this->config->spool_dir );
		$result = array(
			'errors' => array(),
			'events' => 0,
			'lines'  => 0,
		);

		if ( ! is_dir( $spool->dir() ) && ! @mkdir( $spool->dir(), 0700, true ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors
			$result['errors'][] = 'spool folder is not writable';
			return $result;
		}

		$lock = @fopen( $spool->dir() . '/ship.lock', 'c' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		if ( false === $lock || ! flock( $lock, LOCK_EX | LOCK_NB ) ) {
			$result['errors'][] = 'another ship run is in progress';
			return $result;
		}

		try {
			foreach ( $spool->claim() as $file ) {
				$records = Patronage_Logging_Spool::read( $file );
				if ( ! $this->send_all( $records ) ) {
					$result['errors'][] = 'sending events failed; will retry';
					break;
				}
				$result['events'] += count( $records );
				@unlink( $file ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
			}

			foreach ( $this->log_files() as $path ) {
				$sent = $this->ship_file( $path );
				if ( null === $sent ) {
					$result['errors'][] = 'sending ' . basename( $path ) . ' failed; will retry';
					continue;
				}
				$result['lines'] += $sent;
			}
		} finally {
			flock( $lock, LOCK_UN );
			fclose( $lock );
		}

		return $result;
	}

	/**
	 * @return list<string>
	 */
	public function log_files(): array {
		$paths = array();
		foreach ( $this->config->files as $pattern ) {
			$matches = glob( $pattern );
			if ( false !== $matches ) {
				foreach ( $matches as $match ) {
					if ( is_file( $match ) && is_readable( $match ) ) {
						$paths[] = $match;
					}
				}
			}
		}
		$paths = array_values( array_unique( $paths ) );
		sort( $paths );
		return $paths;
	}

	/**
	 * Send the complete lines added since the last run. A file that shrank or
	 * was replaced (log rotation) starts again from the top.
	 */
	public function ship_file( string $path ): ?int {
		$state_path = $this->config->spool_dir . '/files.json';
		$state      = is_file( $state_path ) ? json_decode( (string) file_get_contents( $state_path ), true ) : array();
		$state      = is_array( $state ) ? $state : array();
		$stat       = @stat( $path ); // phpcs:ignore WordPress.PHP.NoSilencedErrors

		if ( false === $stat ) {
			return 0;
		}

		$previous = isset( $state[ $path ] ) && is_array( $state[ $path ] ) ? $state[ $path ] : array();
		$offset   = (int) ( $previous['offset'] ?? 0 );
		if ( (int) ( $previous['inode'] ?? $stat['ino'] ) !== (int) $stat['ino'] || $stat['size'] < $offset ) {
			$offset = 0;
		}
		if ( $stat['size'] === $offset ) {
			return 0;
		}

		$handle = @fopen( $path, 'rb' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		if ( false === $handle ) {
			return 0;
		}
		fseek( $handle, $offset );
		$chunk = (string) fread( $handle, self::MAX_FILE_BYTES );
		fclose( $handle );

		$end = strrpos( $chunk, "\n" );
		if ( false === $end ) {
			return 0;
		}
		$chunk = substr( $chunk, 0, $end + 1 );

		$records = array();
		$now     = gmdate( 'Y-m-d\TH:i:s.v\Z' );
		foreach ( explode( "\n", rtrim( $chunk, "\n" ) ) as $line ) {
			if ( '' === trim( $line ) ) {
				continue;
			}
			$records[] = array(
				'file'      => basename( $path ),
				'line'      => substr( $line, 0, self::MAX_LINE_LENGTH ),
				'site'      => $this->config->site,
				'source'    => 'wordpress-server',
				'timestamp' => $now,
			);
		}

		if ( ! $this->send_all( $records ) ) {
			return null;
		}

		$state[ $path ] = array(
			'inode'  => (int) $stat['ino'],
			'offset' => $offset + strlen( $chunk ),
		);
		file_put_contents( $state_path, (string) json_encode( $state ), LOCK_EX );
		return count( $records );
	}

	/**
	 * @param list<array<string,mixed>> $records
	 */
	private function send_all( array $records ): bool {
		$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
		$batch = array();
		$bytes = 2;

		foreach ( $records as $record ) {
			$encoded = json_encode( $record, $flags );
			if ( false === $encoded ) {
				continue;
			}
			$size = strlen( $encoded ) + 1;
			if ( array() !== $batch && ( count( $batch ) >= self::BATCH_RECORDS || $bytes + $size > self::BATCH_BYTES ) ) {
				if ( ! $this->send_batch( $batch ) ) {
					return false;
				}
				$batch = array();
				$bytes = 2;
			}
			$batch[] = $encoded;
			$bytes  += $size;
		}

		return array() === $batch || $this->send_batch( $batch );
	}

	/**
	 * @param list<string> $encoded Records already encoded as JSON.
	 */
	private function send_batch( array $encoded ): bool {
		return ( $this->send )( $this->config->endpoint, '[' . implode( ',', $encoded ) . ']' );
	}

	private function post( string $endpoint, string $body ): bool {
		if ( ! function_exists( 'wp_remote_post' ) ) {
			return false;
		}
		$response = wp_remote_post(
			$endpoint,
			array(
				'body'    => $body,
				'headers' => array(
					'Authorization' => 'Bearer ' . $this->config->token,
					'Content-Type'  => 'application/json',
				),
				'timeout' => 15,
			)
		);
		if ( is_wp_error( $response ) ) {
			return false;
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		return $code >= 200 && $code < 300;
	}
}

/**
 * `wp patronage-logging ship|status|test`. With logging off, each says so and
 * exits cleanly, so a server cron set up ahead of time does no harm.
 */
final class Patronage_Logging_Command {
	/**
	 * Send spooled events and new log-file lines to the stream.
	 */
	public function ship(): void {
		$config = Patronage_Logging_Config::from_constants();
		if ( null === $config ) {
			return;
		}
		$result = ( new Patronage_Logging_Shipper( $config ) )->run();
		foreach ( $result['errors'] as $error ) {
			WP_CLI::warning( $error );
		}
		WP_CLI::log( sprintf( 'Sent %d events and %d log lines.', $result['events'], $result['lines'] ) );
	}

	/**
	 * Show whether logging is on and what it will send.
	 */
	public function status(): void {
		$config = Patronage_Logging_Config::from_constants();
		if ( null === $config ) {
			WP_CLI::log( 'Logging is off: PATRONAGE_LOGGING_ENDPOINT and PATRONAGE_LOGGING_TOKEN are not both set.' );
			return;
		}
		$shipper = new Patronage_Logging_Shipper( $config );
		WP_CLI::log( 'Logging is on.' );
		WP_CLI::log( 'Site: ' . $config->site );
		WP_CLI::log( 'Spool: ' . $config->spool_dir );
		WP_CLI::log( 'WP-Cron shipping: ' . ( $config->wp_cron ? 'on' : 'off' ) );
		foreach ( $shipper->log_files() as $path ) {
			WP_CLI::log( 'Log file: ' . $path );
		}
	}

	/**
	 * Send one test event straight to the stream.
	 */
	public function test(): void {
		$config = Patronage_Logging_Config::from_constants();
		if ( null === $config ) {
			WP_CLI::error( 'Logging is off.' );
		}
		Patronage_Logging_Recorder::register( $config );
		Patronage_Logging_Recorder::record( 'logging.test' );
		Patronage_Logging_Recorder::flush();
		$result = ( new Patronage_Logging_Shipper( $config ) )->run();
		if ( array() !== $result['errors'] ) {
			WP_CLI::error( implode( '; ', $result['errors'] ) );
		}
		WP_CLI::success( sprintf( 'Sent %d events.', $result['events'] ) );
	}
}

if ( defined( 'PATRONAGE_LOGGING_TESTING' ) ) {
	return;
}

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	WP_CLI::add_command( 'patronage-logging', 'Patronage_Logging_Command' );
}

$patronage_logging_config = Patronage_Logging_Config::from_constants();

if ( null !== $patronage_logging_config ) {
	Patronage_Logging_Recorder::register( $patronage_logging_config );

	if ( $patronage_logging_config->wp_cron ) {
		add_filter(
			'cron_schedules',
			static function ( array $schedules ): array {
				$schedules['patronage_logging_five_minutes'] = array(
					'display'  => 'Every five minutes',
					'interval' => 300,
				);
				return $schedules;
			}
		);
		add_action(
			'patronage_logging_ship',
			static function () use ( $patronage_logging_config ): void {
				( new Patronage_Logging_Shipper( $patronage_logging_config ) )->run();
			}
		);
		add_action(
			'init',
			static function (): void {
				if ( ! wp_next_scheduled( 'patronage_logging_ship' ) ) {
					wp_schedule_event( time() + 60, 'patronage_logging_five_minutes', 'patronage_logging_ship' );
				}
			}
		);
	}
}

unset( $patronage_logging_config );
