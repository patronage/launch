<?php

declare(strict_types=1);

// The headless theme forces two WPGraphQL Smart Cache settings through the
// graphql_get_setting_section_fields filter. This checks the filter forces
// them whatever is stored for the section: nothing, the empty string WPGraphQL
// creates the option with, or an array saved from the settings tab.

define('ABSPATH', __DIR__);
define('MINUTE_IN_SECONDS', 60);

/** @var array<string, callable[]> */
$test_filters = [];

function add_filter(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
  global $test_filters;
  $test_filters[$hook][] = $callback;
}
function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {}

require dirname(__DIR__) . '/wp-content/themes/patronage-headless/inc/persisted-queries.php';

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

$callbacks = $test_filters['graphql_get_setting_section_fields'] ?? [];
check('the theme registers one settings filter', count($callbacks), 1);
$filter = $callbacks[0];

$section = 'graphql_persisted_queries_section';
$locked = ['grant_mode' => 'only_allowed', 'apq_auto_persist_mode' => 'off'];

check('option missing (WPGraphQL passes an empty list)', $filter([], $section), $locked);
check('option created as an empty string', $filter('', $section), $locked);
check('option read as false', $filter(false, $section), $locked);
check('option read as null', $filter(null, $section), $locked);
check(
  'saved settings are overridden and the other fields kept',
  $filter(['grant_mode' => 'public', 'apq_auto_persist_mode' => 'public', 'query_garbage_collect' => 'on'], $section),
  ['grant_mode' => 'only_allowed', 'apq_auto_persist_mode' => 'off', 'query_garbage_collect' => 'on'],
);
check('another section stored as an empty string is left alone', $filter('', 'graphql_general_settings'), '');
check(
  'another section stored as an array is left alone',
  $filter(['graphql_endpoint' => 'graphql'], 'graphql_general_settings'),
  ['graphql_endpoint' => 'graphql'],
);

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
