<?php

declare(strict_types=1);

// The fleet report and health route against WordPress stubs. The report must
// carry an Ed25519 signature over "<site>\n<timestamp>\n<body>" that verifies
// with the site's public key, send the Access service token, and go nowhere
// outside production or while a PATRONAGE_FLEET_* constant is missing. The
// public health route returns only {"status":"ok"}.
//
// The key is a throwaway pair generated for each run. Constants cannot be
// undefined, so each unconfigured case runs in its own PHP process:
// `php fleet.test.php --case=<name>` prints what that process sent as JSON.

define('ABSPATH', __DIR__);
define('WPMU_PLUGIN_DIR', __DIR__ . '/no-mu-plugins');
define('HOUR_IN_SECONDS', 3600);
define('MINUTE_IN_SECONDS', 60);

/** @var array<string, callable[]> */
$test_actions = [];
/** @var array<string, array> */
$test_routes = [];
/** @var array<int, array{url: string, args: array}> */
$test_posts = [];
/** @var array<int, array> */
$test_scheduled = [];
/** @var array<string, mixed> */
$test_options = [];
$test_environment = 'production';
/** @var array|WP_Error */
$test_response = ['response' => ['code' => 202], 'body' => 'accepted'];

function add_action(string $hook, callable|string $callback, int $priority = 10, int $accepted_args = 1): void {
  global $test_actions;
  $test_actions[$hook][] = $callback;
}
function do_test_action(string $hook): void {
  global $test_actions;
  foreach ($test_actions[$hook] ?? [] as $callback) {
    $callback();
  }
}
function wp_get_environment_type(): string {
  global $test_environment;
  return $test_environment;
}
function is_wp_error(mixed $value): bool {
  return $value instanceof WP_Error;
}
function get_option(string $name, mixed $default = false): mixed {
  return $name === 'active_plugins' ? ['garden-tools/garden-tools.php'] : $default;
}
function is_multisite(): bool {
  return false;
}
function is_main_site(): bool {
  return true;
}
function get_site_option(string $name, mixed $default = false): mixed {
  global $test_options;
  return $test_options[$name] ?? $default;
}
function update_site_option(string $name, mixed $value): bool {
  global $test_options;
  $test_options[$name] = $value;
  return true;
}
function get_site_transient(string $name): mixed {
  return $name === 'update_plugins'
    ? (object) ['response' => ['garden-tools/garden-tools.php' => (object) ['new_version' => '2.1.0']]]
    : (object) ['response' => []];
}
function get_plugins(): array {
  return [
    'garden-tools/garden-tools.php' => ['Version' => '2.0.3'],
    'seed-library.php' => ['Version' => '1.4.0'],
  ];
}
function get_mu_plugins(): array {
  return ['patronage-fleet.php' => ['Version' => '1.2.0']];
}
function get_file_data(string $file, array $headers): array {
  return ['Version' => ''];
}
function wp_get_themes(): array {
  return [
    'patronage-timber' => new class {
      public function get(string $header): string {
        return '1.0.0';
      }
    },
  ];
}
function get_stylesheet(): string {
  return 'patronage-timber';
}
function get_template(): string {
  return 'patronage-timber';
}
function get_bloginfo(string $show): string {
  return '6.9.1';
}
function home_url(string $path = ''): string {
  return 'https://site.example' . $path;
}
function wp_json_encode(mixed $value, int $flags = 0): string|false {
  return json_encode($value, $flags);
}
function wp_remote_post(string $url, array $args): array|WP_Error {
  global $test_posts, $test_response;
  $test_posts[] = ['url' => $url, 'args' => $args];
  return $test_response;
}
function wp_remote_retrieve_response_code(array $response): int {
  return $response['response']['code'];
}
function wp_remote_retrieve_body(array $response): string {
  return $response['body'];
}
function wp_next_scheduled(string $hook): int|false {
  global $test_scheduled;
  foreach ($test_scheduled as $event) {
    if ($event['hook'] === $hook) {
      return $event['time'];
    }
  }
  return false;
}
function wp_schedule_event(int $time, string $recurrence, string $hook): bool {
  global $test_scheduled;
  $test_scheduled[] = ['time' => $time, 'recurrence' => $recurrence, 'hook' => $hook];
  return true;
}
function wp_schedule_single_event(int $time, string $hook): bool {
  global $test_scheduled;
  $test_scheduled[] = ['time' => $time, 'recurrence' => null, 'hook' => $hook];
  return true;
}
function wp_rand(int $min, int $max): int {
  return $min;
}
function register_rest_route(string $namespace, string $route, array $args): void {
  global $test_routes;
  $test_routes["{$namespace}{$route}"] = $args;
}

class WP_Error {
  public function __construct(public string $code = '', public string $message = '') {}
  public function get_error_message(): string {
    return $this->message;
  }
}

class WP_REST_Response {
  public array $headers = [];
  public function __construct(public mixed $data = null, public int $status = 200) {}
  public function header(string $name, string $value): void {
    $this->headers[$name] = $value;
  }
}

/** Answers SELECT 1 the way $wpdb does, or not at all when the database is down. */
class TestWpdb {
  public bool $up = true;
  public function suppress_errors(bool $suppress = true): bool {
    return false;
  }
  public function get_var(string $query): ?string {
    return $this->up && $query === 'SELECT 1' ? '1' : null;
  }
}
$wpdb = new TestWpdb();

/** A throwaway Ed25519 seed and its public key, or null without sodium. */
function test_keys(): ?array {
  if (!function_exists('sodium_crypto_sign_keypair')) {
    return null;
  }
  $secret = sodium_crypto_sign_secretkey(sodium_crypto_sign_keypair());
  // A libsodium Ed25519 secret key is the 32-byte seed followed by the public key.
  $seed = substr($secret, 0, SODIUM_CRYPTO_SIGN_SEEDBYTES);
  return ['seed' => base64_encode($seed), 'public' => sodium_crypto_sign_publickey(sodium_crypto_sign_seed_keypair($seed))];
}

$keys = test_keys();
$constants = [
  'PATRONAGE_FLEET_SITE' => 'demo-garden',
  'PATRONAGE_FLEET_KEY' => $keys['seed'] ?? base64_encode(str_repeat("\0", 32)),
  'PATRONAGE_FLEET_ACCESS_ID' => 'test-access-id.access',
  'PATRONAGE_FLEET_ACCESS_SECRET' => 'test-access-secret',
];

$case = null;
foreach (array_slice($argv, 1) as $arg) {
  if (str_starts_with($arg, '--case=')) {
    $case = substr($arg, strlen('--case='));
  }
}
if ($case !== null) {
  if (str_starts_with($case, 'missing:')) {
    unset($constants[substr($case, strlen('missing:'))]);
  } elseif (str_starts_with($case, 'empty:')) {
    $constants[substr($case, strlen('empty:'))] = '';
  } elseif ($case === 'bad-key') {
    $constants['PATRONAGE_FLEET_KEY'] = 'not-a-seed';
  } elseif (str_starts_with($case, 'environment:')) {
    $test_environment = substr($case, strlen('environment:'));
  }
}
foreach ($constants as $name => $value) {
  define($name, $value);
}
define('PATRONAGE_FLEET_URL', 'https://fleet.test/api/inventory/report');

require dirname(__DIR__) . '/patronage-fleet.php';

do_test_action('rest_api_init');

// A child process: try every way the plugin sends, print what it sent, stop.
if ($case !== null) {
  do_test_action('init');
  do_test_action('upgrader_process_complete');
  $result = patronage_fleet_send();
  echo json_encode([
    'ok' => $result['ok'],
    'message' => $result['message'],
    'posts' => count($test_posts),
    'scheduled' => count($test_scheduled),
    'health' => json_encode(patronage_fleet_health()->data),
  ]);
  exit(0);
}

$failures = 0;
function check(string $label, mixed $actual, mixed $expected): void {
  global $failures;
  if ($actual === $expected) {
    echo "ok    {$label}\n";
    return;
  }
  $failures++;
  echo "FAIL  {$label}\n      expected " . var_export($expected, true) . "\n      actual   " . var_export($actual, true) . "\n";
}

/**
 * What each case's process sent, by case. The processes run side by side.
 *
 * @return array<string, ?array>
 */
function run_cases(array $cases): array {
  $running = [];
  foreach ($cases as $case) {
    $command = [PHP_BINARY, '-d', 'opcache.enable_cli=0', __FILE__, "--case={$case}"];
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $running[$case] = [$process, $pipes];
  }
  $sent = [];
  foreach ($running as $case => [$process, $pipes]) {
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $sent[$case] = proc_close($process) === 0 ? json_decode((string) $out, true) : null;
    if ($sent[$case] === null) {
      echo "      {$case} failed: {$out}{$err}\n";
    }
  }
  return $sent;
}

// Nothing goes out unless every constant is set, in production.
$environments = ['staging', 'development', 'local'];
$cases = run_cases([
  ...array_map(fn($name) => "missing:{$name}", array_keys($constants)),
  ...array_map(fn($name) => "empty:{$name}", array_keys($constants)),
  ...array_map(fn($environment) => "environment:{$environment}", $environments),
  'bad-key',
]);
$silent = ['ok' => false, 'posts' => 0, 'scheduled' => 0];
foreach (array_keys($constants) as $name) {
  $sent = $cases["missing:{$name}"];
  check("sends and schedules nothing without {$name}", array_intersect_key($sent ?? [], $silent), $silent);
  $sent = $cases["empty:{$name}"];
  check("sends and schedules nothing with an empty {$name}", array_intersect_key($sent ?? [], $silent), $silent);
}
foreach ($environments as $environment) {
  $sent = $cases["environment:{$environment}"];
  check("sends and schedules nothing in {$environment}", array_intersect_key($sent ?? [], $silent), $silent);
  check("still answers the health check in {$environment}", $sent['health'] ?? null, '{"status":"ok"}');
}

// The health route.
$health = $test_routes['patronage-fleet/v1/health'] ?? [];
check('the health route is a public GET', [$health['methods'] ?? null, $health['permission_callback'] ?? null], ['GET', '__return_true']);
$response = patronage_fleet_health();
check('the health check answers 200', $response->status, 200);
check('the health payload is exactly {"status":"ok"}', json_encode($response->data), '{"status":"ok"}');
check('the health check is never cached', $response->headers['Cache-Control'] ?? null, 'no-store, max-age=0');
$wpdb->up = false;
$down = patronage_fleet_health();
check('the health check answers 503 when the database does not', [$down->status, json_encode($down->data)], [503, '{"status":"database unavailable"}']);
$wpdb->up = true;

if ($keys === null) {
  echo "\nnote  PHP's sodium extension is missing: the signed report is not checked\n";
} else {
  $bad = $cases['bad-key'];
  check('sends nothing with a key that is not a base64 Ed25519 seed', [$bad['posts'] ?? null, $bad['message'] ?? null], [0, 'PATRONAGE_FLEET_KEY is not a base64 Ed25519 seed']);

  do_test_action('init');
  check('schedules one daily report in production', array_map(fn($event) => [$event['hook'], $event['recurrence']], $test_scheduled), [['patronage_fleet_report', 'daily']]);

  $before = time();
  $result = patronage_fleet_send();
  check('reports the accepted report', $result, ['ok' => true, 'status' => 202, 'message' => 'accepted']);
  check('sends one report to the configured URL', array_column($test_posts, 'url'), ['https://fleet.test/api/inventory/report']);

  $args = $test_posts[0]['args'] ?? ['headers' => [], 'body' => ''];
  $headers = $args['headers'];
  check('does not follow a redirect from Access', $args['redirection'] ?? null, 0);
  check(
    'sends the Access service token and the site',
    [$headers['cf-access-client-id'] ?? null, $headers['cf-access-client-secret'] ?? null, $headers['x-fleet-site'] ?? null],
    ['test-access-id.access', 'test-access-secret', 'demo-garden'],
  );
  $timestamp = (string) ($headers['x-fleet-timestamp'] ?? '');
  check('timestamps the report with the current time', ctype_digit($timestamp) && (int) $timestamp >= $before && (int) $timestamp <= time(), true);

  $signature = base64_decode((string) ($headers['x-fleet-signature'] ?? ''), true) ?: '';
  $signed = "demo-garden\n{$timestamp}\n{$args['body']}";
  check(
    'the signature verifies with the public key',
    strlen($signature) === SODIUM_CRYPTO_SIGN_BYTES && sodium_crypto_sign_verify_detached($signature, $signed, $keys['public']),
    true,
  );
  check(
    'the signature does not verify for a changed body',
    strlen($signature) === SODIUM_CRYPTO_SIGN_BYTES && sodium_crypto_sign_verify_detached($signature, $signed . ' ', $keys['public']),
    false,
  );
  $other = sodium_crypto_sign_publickey(sodium_crypto_sign_keypair());
  check(
    'the signature does not verify with another site\'s key',
    strlen($signature) === SODIUM_CRYPTO_SIGN_BYTES && sodium_crypto_sign_verify_detached($signature, $signed, $other),
    false,
  );

  $body = json_decode((string) $args['body'], true);
  check(
    'the body is the inventory',
    [$body['reporter'] ?? null, $body['core'] ?? null, $body['home'] ?? null, $body['php'] ?? null],
    [PATRONAGE_FLEET_VERSION, '6.9.1', 'https://site.example', PHP_VERSION],
  );
  check(
    'the inventory lists plugins with their version, state and update',
    $body['plugins'] ?? null,
    [
      ['slug' => 'garden-tools', 'version' => '2.0.3', 'active' => true, 'update' => '2.1.0'],
      ['slug' => 'seed-library', 'version' => '1.4.0', 'active' => false, 'update' => null],
      ['slug' => 'patronage-fleet', 'version' => '1.2.0', 'active' => true, 'update' => null, 'mu' => true],
    ],
  );
  check('the inventory lists the active theme', $body['themes'] ?? null, [['slug' => 'patronage-timber', 'version' => '1.0.0', 'active' => true, 'update' => null]]);
  check('records the last result', ($test_options[PATRONAGE_FLEET_STATUS]['ok'] ?? null), true);

  $test_response = ['response' => ['code' => 302], 'body' => '<html>sign in</html>'];
  check(
    'reports a redirect as Access refusing the token',
    patronage_fleet_send(),
    ['ok' => false, 'status' => 302, 'message' => 'Cloudflare Access refused the service token (check PATRONAGE_FLEET_ACCESS_ID and _SECRET)'],
  );
  $test_response = new WP_Error('http_request_failed', 'Could not resolve host');
  check('reports a failed request', patronage_fleet_send(), ['ok' => false, 'status' => 0, 'message' => 'Could not resolve host']);
}

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
