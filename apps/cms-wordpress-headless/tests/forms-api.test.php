<?php

declare(strict_types=1);

// The form submissions route, POST /wp-json/patronage/v1/forms/<id>/submissions,
// against WordPress stubs. Its permission callback lets a request in only with
// the shared HEADLESS_SECRET in X-Headless-Secret-Key, and never when the
// secret is empty or undefined. The shared form checks are stubbed here; they
// are tested in wordpress-shared/patronage-fields/tests/forms.test.php.
//
// A constant cannot be undefined or redefined, so each HEADLESS_SECRET case
// runs in its own PHP process: `php forms-api.test.php --secret=<mode>` prints
// the callback's answers as JSON.

define('ABSPATH', __DIR__);

/** @var array<string, callable[]> */
$test_actions = [];
/** @var array<string, array> */
$test_routes = [];

function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
  global $test_actions;
  $test_actions[$hook][] = $callback;
}
function register_rest_route(string $namespace, string $route, array $args): void {
  global $test_routes;
  $test_routes["{$namespace}{$route}"] = $args;
}
function is_wp_error(mixed $value): bool {
  return $value instanceof WP_Error;
}

class WP_Error {
  public function __construct(public string $code = '', public string $message = '', public mixed $data = '') {}
}

class WP_REST_Response {
  public function __construct(public mixed $data = null, public int $status = 200) {}
}

class WP_REST_Request implements ArrayAccess {
  public function __construct(private array $headers = [], private array $params = [], private ?array $json = null) {}
  public function get_header(string $name): ?string {
    return $this->headers[strtolower($name)] ?? null;
  }
  public function get_json_params(): ?array {
    return $this->json;
  }
  public function offsetExists(mixed $offset): bool {
    return isset($this->params[$offset]);
  }
  public function offsetGet(mixed $offset): mixed {
    return $this->params[$offset] ?? null;
  }
  public function offsetSet(mixed $offset, mixed $value): void {
    $this->params[$offset] = $value;
  }
  public function offsetUnset(mixed $offset): void {
    unset($this->params[$offset]);
  }
}

// Stand-ins for wordpress-shared/patronage-fields/forms.php.
$test_saved = [];
function patronage_fields_formidable_form(int $id): ?object {
  return $id === 3 ? (object) ['id' => '3'] : null;
}
function patronage_fields_form_save(object $form, array $values): true|WP_Error {
  global $test_saved;
  if (($values['email'] ?? '') === '') {
    return new WP_Error('patronage_form_invalid', 'email is required.', ['status' => 400]);
  }
  $test_saved[] = $values;
  return true;
}

$mode = null;
foreach (array_slice($argv, 1) as $arg) {
  if (str_starts_with($arg, '--secret=')) {
    $mode = substr($arg, strlen('--secret='));
  }
}
if ($mode === 'empty') {
  define('HEADLESS_SECRET', '');
} elseif ($mode === 'set') {
  define('HEADLESS_SECRET', 'test-secret-value');
}

require dirname(__DIR__) . '/wp-content/themes/patronage-headless/inc/forms-api.php';

foreach ($test_actions['rest_api_init'] ?? [] as $init) {
  $init();
}
$route = $test_routes['patronage/v1/forms/(?P<id>\d+)/submissions'] ?? null;
if (!$route) {
  echo "FAIL  the theme registers the submissions route\n";
  exit(1);
}
$allowed = fn(array $headers) => ($route['permission_callback'])(new WP_REST_Request($headers));

// A child process: print each header case's answer and stop.
if ($mode !== null) {
  echo json_encode([
    'none' => $allowed([]),
    'empty' => $allowed(['x-headless-secret-key' => '']),
    'wrong' => $allowed(['x-headless-secret-key' => 'not-the-secret']),
    'prefix' => $allowed(['x-headless-secret-key' => 'test-secret']),
    'right' => $allowed(['x-headless-secret-key' => 'test-secret-value']),
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

/** The permission callback's answers in a process with the given secret. */
function answers(string $mode): ?array {
  $command = [PHP_BINARY, '-d', 'opcache.enable_cli=0', __FILE__, "--secret={$mode}"];
  $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
  $out = stream_get_contents($pipes[1]);
  $err = stream_get_contents($pipes[2]);
  fclose($pipes[1]);
  fclose($pipes[2]);
  if (proc_close($process) !== 0) {
    echo $out . $err;
    return null;
  }
  return json_decode((string) $out, true);
}

$refusesAll = ['none' => false, 'empty' => false, 'wrong' => false, 'prefix' => false, 'right' => false];

check('the route takes POST only', $route['methods'], 'POST');
check('refuses every request when HEADLESS_SECRET is not defined', answers('undefined'), $refusesAll);
check('refuses every request, even an empty header, when HEADLESS_SECRET is empty', answers('empty'), $refusesAll);

$set = answers('set');
check('refuses a request without the header', $set['none'] ?? null, false);
check('refuses an empty header', $set['empty'] ?? null, false);
check('refuses a wrong secret', $set['wrong'] ?? null, false);
check('refuses a prefix of the secret', $set['prefix'] ?? null, false);
check('accepts the right secret', $set['right'] ?? null, true);

// The callback, past the permission check.
$submit = fn(int $id, ?array $json) => ($route['callback'])(new WP_REST_Request([], ['id' => (string) $id], $json));
$missing = $submit(99, ['values' => ['email' => 'reader@example.com']]);
check('answers 404 for a form that is missing or unpublished', [$missing->code ?? null, $missing->data ?? null], ['patronage_form_missing', ['status' => 404]]);
$noValues = $submit(3, ['email' => 'reader@example.com']);
check('answers 400 for a body without { values }', [$noValues->code ?? null, $noValues->data ?? null], ['patronage_form_invalid', ['status' => 400]]);
$stringValues = $submit(3, ['values' => 'email=reader@example.com']);
check('answers 400 when values is not an object', $stringValues->code ?? null, 'patronage_form_invalid');
$invalid = $submit(3, ['values' => ['email' => '']]);
check('passes on the checks\' problem', [$invalid->message ?? null, $invalid->data ?? null], ['email is required.', ['status' => 400]]);
$saved = $submit(3, ['values' => ['email' => 'reader@example.com']]);
check('answers 201 once the entry is saved', [$saved instanceof WP_REST_Response ? $saved->status : null, $saved->data ?? null], [201, ['ok' => true]]);
check('saves only the valid submission', $test_saved, [['email' => 'reader@example.com']]);

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
