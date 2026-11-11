<?php

declare(strict_types=1);

// field-values.php against WordPress and ACF stubs: the post meta the field
// groups store is protected, other meta is left as WordPress decided, and
// get_field() is told not to return values that have no field behind them.

define('ABSPATH', __DIR__);

/** @var array<string, callable[]> */
$test_filters = [];
$test_acf_init = 'before';

function add_filter(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
  global $test_filters;
  $test_filters[$hook][] = $callback;
}
function apply_filters(string $hook, mixed $value, mixed ...$args): mixed {
  global $test_filters;
  foreach ($test_filters[$hook] ?? [] as $callback) {
    $value = $callback($value, ...$args);
  }
  return $value;
}
function __return_true(): bool {
  return true;
}
function did_action(string $hook): int {
  global $test_acf_init;
  return $hook === 'acf/init' && $test_acf_init !== 'before' ? 1 : 0;
}
function doing_action(string $hook): bool {
  global $test_acf_init;
  return $hook === 'acf/init' && $test_acf_init === 'during';
}

// ACF's local store, as it holds the Hero and Page Builder groups: sub fields
// are fields of their own, pointing at their parent's key.
/** @var array<int, array{key: string, name: string, parent: string}> */
$test_fields = [];
function acf_get_local_field_groups(): array {
  return [['key' => 'group_hero'], ['key' => 'group_page_builder']];
}
function acf_get_local_fields(string $parent = ''): array {
  global $test_fields;
  return array_values(array_filter($test_fields, fn(array $field): bool => $field['parent'] === $parent));
}

require dirname(__DIR__) . '/field-values.php';

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
function is_protected(mixed $key, string $type = 'post', bool $already = false): mixed {
  return apply_filters('is_protected_meta', $already, $key, $type);
}

// Before acf/init no field group is registered, and nothing is remembered.
check('before acf/init: body is not protected', is_protected('body'), false);

// While acf/init runs the groups are still registering: answer from what is
// there, without keeping it.
$test_acf_init = 'during';
$test_fields = [['key' => 'field_hero_variant', 'name' => 'variant', 'parent' => 'group_hero']];
check('during acf/init: a registered field is protected', is_protected('variant'), true);
check('during acf/init: a field not yet registered is not', is_protected('body'), false);

$test_acf_init = 'after';
$test_fields = [
  ['key' => 'field_hero_variant', 'name' => 'variant', 'parent' => 'group_hero'],
  ['key' => 'field_hero_title', 'name' => 'title', 'parent' => 'group_hero'],
  ['key' => 'field_hero_body', 'name' => 'body', 'parent' => 'group_hero'],
  ['key' => 'field_hero_image', 'name' => 'image', 'parent' => 'group_hero'],
  ['key' => 'field_hero_links', 'name' => 'links', 'parent' => 'group_hero'],
  ['key' => 'field_hero_links_link', 'name' => 'link', 'parent' => 'field_hero_links'],
  ['key' => 'field_hero_links_variant', 'name' => 'variant', 'parent' => 'field_hero_links'],
  ['key' => 'field_pb_sections', 'name' => 'sections', 'parent' => 'group_page_builder'],
  ['key' => 'field_pb_content_tab', 'name' => '', 'parent' => 'field_pb_sections'],
  ['key' => 'field_pb_heading', 'name' => 'heading', 'parent' => 'field_pb_sections'],
  ['key' => 'field_pb_body', 'name' => 'body', 'parent' => 'field_pb_sections'],
];

foreach (['variant', 'title', 'body', 'image', 'links', 'sections'] as $key) {
  check("a top-level field is protected: {$key}", is_protected($key), true);
}
foreach (['links_0_link', 'links_2_variant', 'sections_0_body', 'sections_12_section_options_skin'] as $key) {
  check("a row or sub field value is protected: {$key}", is_protected($key), true);
}
// Sub field names are stored under their parent's prefix, never on their own.
foreach (['heading', 'link', 'subtitle', 'bodyx', 'my_body', 'linksfoo', 'title_extra', ''] as $key) {
  check("other meta is not protected: '{$key}'", is_protected($key), false);
}
check('meta WordPress already protects stays protected', is_protected('_edit_lock', 'post', true), true);
check('user meta of the same name is left alone', is_protected('body', 'user'), false);
check('term meta of the same name is left alone', is_protected('sections_0_body', 'term'), false);
check('a key that is not a string is left alone', is_protected(null), false);

// The list is kept once acf/init has finished.
$test_fields = [];
check('the stored names are remembered after acf/init', is_protected('body'), true);

check(
  'get_field() is told not to return values without a field',
  apply_filters('acf/prevent_access_to_unknown_fields', false),
  true,
);

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
