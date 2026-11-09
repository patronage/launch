<?php

declare(strict_types=1);

// Runs the mu-plugin against a small in-memory WordPress: posts with
// permalinks built from their slugs and parents, the hooks it registers, and
// a recorded wp_remote_request. Each section resets the queue by flushing.

define( 'ABSPATH', __DIR__ );

// The plugin logs every send; keep the test output to failures.
ini_set( 'error_log', '/dev/null' );

final class WP_Error {
	public function __construct( public string $code = '', public string $message = '' ) {}

	public function get_error_message(): string {
		return $this->message;
	}
}

final class WP_Post {
	public int $ID = 0;
	public string $post_name = '';
	public int $post_parent = 0;
	public string $post_status = 'publish';
	public string $post_type = 'post';
}

$failures = 0;

function check( bool $condition, string $message ): void {
	global $failures;
	if ( ! $condition ) {
		++$failures;
		fwrite( STDERR, "FAIL: {$message}\n" );
	}
}

// Hooks.

/** @var array<string,list<array{callback:callable,accepted_args:int}>> */
$test_hooks = array();

function add_action( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	global $test_hooks;
	$test_hooks[ $hook ][] = array(
		'accepted_args' => $accepted_args,
		'callback'      => $callback,
	);
}

function add_filter( string $hook, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
	add_action( $hook, $callback, $priority, $accepted_args );
}

function remove_all_filters( string $hook ): void {
	global $test_hooks;
	unset( $test_hooks[ $hook ] );
}

function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	global $test_hooks;
	foreach ( $test_hooks[ $hook ] ?? array() as $registered ) {
		$value = call_user_func_array(
			$registered['callback'],
			array_slice( array_merge( array( $value ), $args ), 0, $registered['accepted_args'] )
		);
	}
	return $value;
}

function do_action( string $hook, mixed ...$args ): void {
	global $test_hooks;
	foreach ( $test_hooks[ $hook ] ?? array() as $registered ) {
		call_user_func_array( $registered['callback'], array_slice( $args, 0, $registered['accepted_args'] ) );
	}
}

// URLs and options.

$test_home = 'https://cms.example';

/** @var array<string,mixed> */
$test_options = array();

function home_url(): string {
	global $test_home;
	return $test_home;
}

function wp_parse_url( string $url, int $component = -1 ): mixed {
	return parse_url( $url, $component );
}

function untrailingslashit( string $value ): string {
	return rtrim( $value, '/\\' );
}

function wp_json_encode( mixed $value, int $flags = 0 ): string|false {
	return json_encode( $value, $flags );
}

function update_option( string $name, mixed $value, bool $autoload = true ): bool {
	global $test_options;
	$test_options[ $name ] = $value;
	return true;
}

function get_option( string $name, mixed $fallback = false ): mixed {
	global $test_options;
	return $test_options[ $name ] ?? $fallback;
}

// Posts. A published post's permalink is its ancestors' slugs and its own,
// with a trailing slash; any other post has a plain ?p= permalink.

/** @var array<int,WP_Post> */
$test_posts = array();

/** @var array<int,array<string,string>> */
$test_meta = array();

function test_post( int $id, string $slug, string $status = 'publish', string $type = 'post', int $parent = 0 ): WP_Post {
	global $test_posts;
	$post              = new WP_Post();
	$post->ID          = $id;
	$post->post_name   = $slug;
	$post->post_status = $status;
	$post->post_type   = $type;
	$post->post_parent = $parent;
	$test_posts[ $id ] = $post;
	return $post;
}

function get_post( int $id ): ?WP_Post {
	global $test_posts;
	return $test_posts[ $id ] ?? null;
}

function get_permalink( WP_Post|int $post ): string|false {
	global $test_posts;
	$post = $post instanceof WP_Post ? $post : ( $test_posts[ $post ] ?? null );
	if ( ! $post ) {
		return false;
	}
	if ( 'publish' !== $post->post_status ) {
		return home_url() . '/?p=' . $post->ID;
	}
	$slugs  = array( $post->post_name );
	$parent = $post->post_parent;
	while ( $parent && isset( $test_posts[ $parent ] ) ) {
		array_unshift( $slugs, $test_posts[ $parent ]->post_name );
		$parent = $test_posts[ $parent ]->post_parent;
	}
	return home_url() . '/' . implode( '/', $slugs ) . '/';
}

/**
 * @param array{post_type:string,post_status:list<string>,post_parent__in:list<int>,post__not_in:list<int>} $query
 * @return list<WP_Post>
 */
function get_posts( array $query ): array {
	global $test_posts;
	return array_values(
		array_filter(
			$test_posts,
			static fn ( WP_Post $post ): bool => $post->post_type === $query['post_type'] &&
				in_array( $post->post_status, $query['post_status'], true ) &&
				in_array( $post->post_parent, $query['post_parent__in'], true ) &&
				! in_array( $post->ID, $query['post__not_in'], true )
		)
	);
}

function get_post_meta( int $id, string $key, bool $single = false ): string {
	global $test_meta;
	return $test_meta[ $id ][ $key ] ?? '';
}

function wp_is_post_revision( WP_Post $post ): bool {
	return 'revision' === $post->post_type;
}

function wp_is_post_autosave( WP_Post $post ): bool {
	return false;
}

function is_post_type_viewable( string $type ): bool {
	return in_array( $type, array( 'post', 'page' ), true );
}

function is_post_type_hierarchical( string $type ): bool {
	return 'page' === $type;
}

// HTTP.

/** @var list<array{url:string,args:array<string,mixed>}> */
$test_requests = array();

/** @var array{response:array{code:int},headers:array<string,string>}|WP_Error */
$test_response = array(
	'headers'  => array(),
	'response' => array( 'code' => 200 ),
);

function wp_remote_request( string $url, array $args ): mixed {
	global $test_requests, $test_response;
	$test_requests[] = array(
		'args' => $args,
		'url'  => $url,
	);
	return $test_response;
}

function is_wp_error( mixed $value ): bool {
	return $value instanceof WP_Error;
}

function wp_remote_retrieve_response_code( array $response ): int {
	return $response['response']['code'];
}

function wp_remote_retrieve_header( array $response, string $name ): string {
	return $response['headers'][ $name ] ?? '';
}

function test_respond( int $code, array $headers = array() ): void {
	global $test_response;
	$test_response = array(
		'headers'  => $headers,
		'response' => array( 'code' => $code ),
	);
}

/** @return array{url:string,args:array<string,mixed>}|null */
function test_last_request(): ?array {
	global $test_requests;
	return $test_requests ? $test_requests[ count( $test_requests ) - 1 ] : null;
}

/** The paths the next flush sends, sorted. */
function test_flushed_paths(): array {
	$paths = patronage_headless_revalidate_flush()['paths'];
	sort( $paths );
	return $paths;
}

require_once dirname( __DIR__ ) . '/patronage-headless-revalidate.php';

// Paths: no host, query or trailing slash, except the home page.
check( '/about/team' === patronage_headless_revalidate_path( 'https://cms.example/about/team/?preview=1' ), 'a URL becomes its path without the query or trailing slash' );
check( '/about' === patronage_headless_revalidate_path( 'about/' ), 'a relative path gains a leading slash' );
check( '/' === patronage_headless_revalidate_path( 'https://cms.example/' ), 'the home page keeps its slash' );
check( '/' === patronage_headless_revalidate_path( '' ), 'an empty path is the home page' );
check( '' === patronage_headless_revalidate_post_path( 'https://cms.example/?p=12' ), 'a plain permalink has no path' );
check( '' === patronage_headless_revalidate_post_path( '' ), 'no permalink has no path' );
check( '/news/hello' === patronage_headless_revalidate_post_path( 'https://cms.example/news/hello/' ), 'a pretty permalink is its path' );

// A subdirectory install maps its home to the front-end root.
$test_home = 'https://cms.example/wp';
check( '/about' === patronage_headless_revalidate_path( 'https://cms.example/wp/about/' ), 'a subdirectory install drops its home path' );
check( '/' === patronage_headless_revalidate_path( 'https://cms.example/wp' ), 'a subdirectory home is the root' );
check( '/wpx' === patronage_headless_revalidate_path( 'https://cms.example/wpx/' ), 'only a whole home segment is dropped' );
check( '/wp/about' === patronage_headless_revalidate_path( '/wp/about/' ), 'a bare path is already a front-end path' );
$test_home = 'https://cms.example';

// Nothing queued: nothing sent.
$sent   = count( $test_requests );
$result = patronage_headless_revalidate_flush();
check( $result['ok'] && 0 === $result['status'] && 'Nothing queued' === $result['message'], 'an empty queue reports nothing queued' );
check( count( $test_requests ) === $sent, 'an empty queue sends nothing' );

// Not configured: the queue is reported, nothing is sent.
patronage_headless_revalidate_queue_paths( array( '/a' ) );
$result = patronage_headless_revalidate_flush();
check( ! $result['ok'] && str_contains( $result['message'], 'PATRONAGE_REVALIDATE_URL' ), 'an unconfigured send fails naming the constants' );
check( array( '/a' ) === $result['paths'], 'an unconfigured send still reports its paths' );
check( count( $test_requests ) === $sent, 'an unconfigured send makes no request' );

define( 'PATRONAGE_REVALIDATE_URL', 'https://www.example.org/' );
define( 'PATRONAGE_REVALIDATE_SECRET', 'revalidate-secret' );

// The queue: paths normalised and de-duplicated, tags de-duplicated, blanks dropped.
patronage_headless_revalidate_queue_paths( array( 'https://cms.example/a/', '/a', '', 'b' ) );
patronage_headless_revalidate_queue_tags( array( 'wordpress', 'wordpress', '', 'post:1' ) );
$result  = patronage_headless_revalidate_flush();
$request = test_last_request();
check( $result['ok'] && 200 === $result['status'], 'a 200 is a successful send' );
check( array( '/a', '/b' ) === $result['paths'], 'queued paths are normalised and de-duplicated' );
check( array( 'wordpress', 'post:1' ) === $result['tags'], 'queued tags are de-duplicated' );
check( null !== $request && 'https://www.example.org/api/revalidate/' === $request['url'], 'the request goes to the front-end revalidate route' );
check( null !== $request && 'PUT' === $request['args']['method'], 'the request is a PUT' );
check( null !== $request && 0 === $request['args']['redirection'], 'the request does not follow redirects' );
check( null !== $request && 'revalidate-secret' === $request['args']['headers']['x-headless-secret-key'], 'the request carries the secret header' );
check( null !== $request && ! isset( $request['args']['headers']['cf-access-client-id'] ), 'no Access headers without an Access token' );
check(
	null !== $request && json_decode( $request['args']['body'], true ) === array(
		'paths' => array( '/a', '/b' ),
		'tags'  => array( 'wordpress', 'post:1' ),
	),
	'the body is the paths and tags as JSON'
);
$stored = get_option( PATRONAGE_HEADLESS_REVALIDATE_STATUS );
check( is_array( $stored ) && true === $stored['ok'] && isset( $stored['at'] ), 'the last send is stored' );
check( ! str_contains( (string) json_encode( $stored ), 'revalidate-secret' ), 'the stored send never holds the secret' );

// How the front-end's answer reads.
patronage_headless_revalidate_queue_paths( array( '/a' ) );
test_respond( 308, array( 'location' => 'https://www.example.org/sign-in' ) );
$result = patronage_headless_revalidate_flush();
check( ! $result['ok'] && str_contains( $result['message'], 'redirected to https://www.example.org/sign-in' ), 'a redirect fails and names where it went' );

patronage_headless_revalidate_queue_paths( array( '/a' ) );
test_respond( 401 );
$result = patronage_headless_revalidate_flush();
check( ! $result['ok'] && str_contains( $result['message'], 'refused PATRONAGE_REVALIDATE_SECRET' ), 'a 401 fails naming the secret' );

patronage_headless_revalidate_queue_paths( array( '/a' ) );
test_respond( 503 );
$result = patronage_headless_revalidate_flush();
check( ! $result['ok'] && 'HTTP 503' === $result['message'], 'another error fails with its status' );

patronage_headless_revalidate_queue_paths( array( '/a' ) );
$test_response = new WP_Error( 'http_request_failed', 'Connection timed out' );
$result        = patronage_headless_revalidate_flush();
check( ! $result['ok'] && 0 === $result['status'] && 'Connection timed out' === $result['message'], 'a transport error fails with its message' );
test_respond( 200 );

// The endpoint filter, for a front-end without trailing slashes.
add_filter( 'patronage_headless_revalidate_endpoint', static fn (): string => '/api/revalidate' );
patronage_headless_revalidate_queue_paths( array( '/a' ) );
patronage_headless_revalidate_flush();
check( 'https://www.example.org/api/revalidate' === test_last_request()['url'], 'the endpoint filter changes the route' );
remove_all_filters( 'patronage_headless_revalidate_endpoint' );

// Shutdown sends nothing when nothing was queued.
$sent = count( $test_requests );
do_action( 'shutdown' );
check( count( $test_requests ) === $sent, 'shutdown with an empty queue sends nothing' );

// Shutdown sends what was queued.
patronage_headless_revalidate_queue_paths( array( '/from-shutdown' ) );
do_action( 'shutdown' );
check( count( $test_requests ) === $sent + 1 && str_contains( test_last_request()['args']['body'], '/from-shutdown' ), 'shutdown sends the queue' );

// Publishing queues the post's path and the wordpress tag.
$post = test_post( 10, 'hello' );
do_action( 'transition_post_status', 'publish', 'draft', $post );
$result = patronage_headless_revalidate_flush();
check( array( '/hello' ) === $result['paths'], 'publishing sends the post path' );
check( array( 'wordpress' ) === $result['tags'], 'publishing sends the wordpress tag' );

// Edits to a published post queue it; drafts, revisions, attachments and
// types with no public URL do not.
do_action( 'transition_post_status', 'publish', 'publish', $post );
check( array( '/hello' ) === test_flushed_paths(), 'editing a published post sends its path' );
do_action( 'transition_post_status', 'draft', 'draft', test_post( 11, 'draft' ) );
do_action( 'transition_post_status', 'publish', 'publish', test_post( 12, 'rev', 'inherit', 'revision' ) );
do_action( 'transition_post_status', 'publish', 'publish', test_post( 13, 'file', 'publish', 'attachment' ) );
do_action( 'transition_post_status', 'publish', 'draft', test_post( 14, 'menu', 'publish', 'nav_menu_item' ) );
check( array() === test_flushed_paths(), 'drafts, revisions, attachments and private types send nothing' );

// The post tags filter adds a post's own tags.
add_filter( 'patronage_headless_revalidate_post_tags', static fn ( array $tags, WP_Post $tagged ): array => array_merge( $tags, array( "post:{$tagged->ID}" ) ), 10, 2 );
do_action( 'transition_post_status', 'publish', 'publish', $post );
check( array( 'wordpress', 'post:10' ) === patronage_headless_revalidate_flush()['tags'], 'the post tags filter adds tags' );
remove_all_filters( 'patronage_headless_revalidate_post_tags' );

// Renaming a published post sends the old path and the new one.
do_action( 'pre_post_update', 10 );
$post->post_name = 'hello-again';
do_action( 'transition_post_status', 'publish', 'publish', $post );
check( array( '/hello', '/hello-again' ) === test_flushed_paths(), 'a rename sends the old and the new path' );

// Unpublishing sends the path the post had.
do_action( 'pre_post_update', 10 );
$post->post_status = 'draft';
do_action( 'transition_post_status', 'draft', 'publish', $post );
check( array( '/hello-again' ) === test_flushed_paths(), 'unpublishing sends the old path' );

// Trashing sends the path from the slug WordPress kept, not the __trashed one.
$trashed = test_post( 20, 'goodbye' );
do_action( 'wp_trash_post', 20 );
$trashed->post_name   = 'goodbye__trashed';
$trashed->post_status = 'trash';
$test_meta[20]        = array( '_wp_desired_post_slug' => 'goodbye' );
do_action( 'transition_post_status', 'trash', 'publish', $trashed );
check( array( '/goodbye' ) === test_flushed_paths(), 'trashing sends the untrashed path' );

// Moving a page moves its published descendants, under a draft one too.
$parent = test_post( 30, 'about', 'publish', 'page' );
test_post( 31, 'team', 'draft', 'page', 30 );
test_post( 32, 'leaders', 'publish', 'page', 31 );
test_post( 33, 'history', 'publish', 'page', 30 );
do_action( 'pre_post_update', 30 );
$parent->post_name = 'company';
do_action( 'transition_post_status', 'publish', 'publish', $parent );
check(
	array( '/about', '/about/history', '/about/team/leaders', '/company', '/company/history', '/company/team/leaders' ) === test_flushed_paths(),
	'moving a page sends each published descendant\'s old and new path'
);

// Only the first URL recorded in a request counts: it is the one cached.
do_action( 'pre_post_update', 33 );
$history            = get_post( 33 );
$history->post_name = 'story';
do_action( 'pre_post_update', 33 );
$history->post_name = 'past';
do_action( 'transition_post_status', 'publish', 'publish', $history );
check( array( '/company/history', '/company/past' ) === test_flushed_paths(), 'two renames in one request send the first old path' );

// Deleting a published post outright sends its path.
$deleted = test_post( 40, 'gone' );
do_action( 'before_delete_post', 40, $deleted );
unset( $test_posts[40] );
check( array( '/gone' ) === test_flushed_paths(), 'deleting a published post sends its path' );

// Deleting a trashed parent moves its published children up a level.
$old_parent = test_post( 50, 'old', 'trash', 'page' );
$child      = test_post( 51, 'child', 'publish', 'page', 50 );
do_action( 'before_delete_post', 50, $old_parent );
unset( $test_posts[50] );
$child->post_parent = 0;
check( array( '/child', '/old/child' ) === test_flushed_paths(), 'deleting a parent sends its children\'s old and new paths' );

// The Access token, when one is defined, rides on every send.
define( 'PATRONAGE_REVALIDATE_ACCESS_ID', 'client-id.access' );
define( 'PATRONAGE_REVALIDATE_ACCESS_SECRET', 'client-secret' );
patronage_headless_revalidate_queue_paths( array( '/a' ) );
patronage_headless_revalidate_flush();
$headers = test_last_request()['args']['headers'];
check( 'client-id.access' === ( $headers['cf-access-client-id'] ?? null ) && 'client-secret' === ( $headers['cf-access-client-secret'] ?? null ), 'the Access token is sent as CF-Access headers' );
check( ! str_contains( (string) json_encode( get_option( PATRONAGE_HEADLESS_REVALIDATE_STATUS ) ), 'client-secret' ), 'the stored send never holds the Access secret' );

if ( $failures > 0 ) {
	fwrite( STDERR, "{$failures} failure(s)\n" );
	exit( 1 );
}

echo "patronage-headless-revalidate: all checks passed\n";
