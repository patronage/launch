<?php

declare(strict_types=1);

// Runs the mu-plugin against a small in-memory WordPress: attachment meta,
// filters, and a recorded WPGraphQL registry.

define('ABSPATH', __DIR__);

$failures = 0;

function check(bool $condition, string $message): void {
  global $failures;
  if (!$condition) {
    ++$failures;
    fwrite(STDERR, "FAIL: {$message}\n");
  }
}

/** @var array<int,array<string,mixed>> */
$test_meta = [];
/** @var array<string,list<callable>> */
$test_hooks = [];
/** @var array<string,array<string,mixed>> */
$test_graphql = [];

function get_post_meta(int $id, string $key, bool $single = false): mixed {
  global $test_meta;
  return $test_meta[$id][$key] ?? '';
}

function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
  global $test_hooks;
  $test_hooks[$hook][] = $callback;
}

function add_filter(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
  add_action($hook, $callback, $priority, $accepted_args);
}

function remove_all_filters(string $hook): void {
  global $test_hooks;
  unset($test_hooks[$hook]);
}

function apply_filters(string $hook, mixed $value, mixed ...$args): mixed {
  global $test_hooks;
  foreach ($test_hooks[$hook] ?? [] as $callback) {
    $value = $callback($value, ...$args);
  }
  return $value;
}

function do_action(string $hook, mixed ...$args): void {
  global $test_hooks;
  foreach ($test_hooks[$hook] ?? [] as $callback) {
    $callback(...$args);
  }
}

function __(string $text, string $domain = 'default'): string {
  return $text;
}

function register_graphql_object_type(string $name, array $config): void {
  global $test_graphql;
  $test_graphql["type:{$name}"] = $config;
}

function register_graphql_field(string $type, string $field, array $config): void {
  global $test_graphql;
  $test_graphql["{$type}.{$field}"] = $config;
}

require dirname(__DIR__) . '/patronage-focal-point.php';

$mfp = PATRONAGE_FOCAL_POINT_MFP_META;
$theia = PATRONAGE_FOCAL_POINT_THEIA_META;

// Media Focus Point's CSS position.
$test_meta[1] = [$mfp => '45% 34%'];
check(['x' => 0.45, 'y' => 0.34] === patronage_focal_point(1), 'reads a Media Focus Point position as fractions');

$test_meta[2] = [$mfp => ' 12.5%  87.25% '];
check(['x' => 0.125, 'y' => 0.8725] === patronage_focal_point(2), 'reads decimal percentages and loose spacing');

$test_meta[3] = [$mfp => '0% 100%'];
check(['x' => 0.0, 'y' => 1.0] === patronage_focal_point(3), 'keeps the edges');

$test_meta[4] = [$mfp => '150% 20%'];
check(['x' => 1.0, 'y' => 0.2] === patronage_focal_point(4), 'clamps a typed value above 100%');

foreach (['center', '45%', '45 34', '-10% 20%', '45% 34% 10%', 'calc(1%) 2%'] as $i => $bad) {
  $test_meta[10 + $i] = [$mfp => $bad];
  check(null === patronage_focal_point(10 + $i), "ignores a malformed position: {$bad}");
}

// Theia Smart Thumbnails' pair.
$test_meta[20] = [$theia => [0.25, 0.7]];
check(['x' => 0.25, 'y' => 0.7] === patronage_focal_point(20), 'reads a Theia pair');

$test_meta[21] = [$theia => (object) ['0' => '0.3', '1' => '0.6']];
check(['x' => 0.3, 'y' => 0.6] === patronage_focal_point(21), 'reads a Theia pair saved as an object of strings');

$test_meta[22] = [$theia => [1.4, -0.2]];
check(['x' => 1.0, 'y' => 0.0] === patronage_focal_point(22), 'clamps a Theia pair');

foreach ([[0.5], ['a', 0.5], 'x', ''] as $i => $bad) {
  $test_meta[30 + $i] = [$theia => $bad];
  check(null === patronage_focal_point(30 + $i), 'ignores a malformed Theia value');
}

// Media Focus Point first, Theia when it has nothing usable.
$test_meta[40] = [$mfp => '10% 20%', $theia => [0.9, 0.9]];
check(['x' => 0.1, 'y' => 0.2] === patronage_focal_point(40), 'prefers Media Focus Point over Theia');

$test_meta[41] = [$mfp => 'junk', $theia => [0.9, 0.8]];
check(['x' => 0.9, 'y' => 0.8] === patronage_focal_point(41), 'falls back to Theia when the Media Focus Point value is malformed');

$test_meta[42] = [$theia => [0.9, 0.8]];
check(['x' => 0.9, 'y' => 0.8] === patronage_focal_point(42), 'falls back to Theia when Media Focus Point has no point');

check(null === patronage_focal_point(99), 'an image with no point is null');

// The filter.
add_filter('patronage_focal_point', fn($point, $id) => $id === 99 ? ['x' => 0.2, 'y' => '0.4'] : $point, 10, 2);
check(['x' => 0.2, 'y' => 0.4] === patronage_focal_point(99), 'the filter can supply a point');
check(['x' => 0.45, 'y' => 0.34] === patronage_focal_point(1), 'the filter passes other points through');
remove_all_filters('patronage_focal_point');

add_filter('patronage_focal_point', fn() => 'nonsense');
check(null === patronage_focal_point(1), 'a malformed filter result is null');
remove_all_filters('patronage_focal_point');

add_filter('patronage_focal_point', fn() => ['x' => 2, 'y' => -1]);
check(['x' => 1.0, 'y' => 0.0] === patronage_focal_point(1), 'a filter result is clamped');
remove_all_filters('patronage_focal_point');

// GraphQL.
do_action('graphql_register_types');
check(isset($test_graphql['type:FocalPoint']['fields']['x'], $test_graphql['type:FocalPoint']['fields']['y']), 'registers the FocalPoint type with x and y');
check('FocalPoint' === ($test_graphql['MediaItem.focalPoint']['type'] ?? null), 'registers MediaItem.focalPoint');
$resolve = $test_graphql['MediaItem.focalPoint']['resolve'];
check(['x' => 0.45, 'y' => 0.34] === $resolve((object) ['databaseId' => 1]), 'the field resolves from the media item\'s database id');
check(null === $resolve((object) ['databaseId' => 99]), 'the field resolves to null without a point');

if ($failures > 0) {
  fwrite(STDERR, "{$failures} failure(s)\n");
  exit(1);
}

echo "patronage-focal-point: all checks passed\n";
