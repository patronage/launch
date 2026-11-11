<?php
/**
 * Keeps field values behind the field editor.
 *
 * ACF stores each field as plain post meta under the field's name (`body`,
 * `sections_0_heading`) and filters what a user may save only in its own
 * editor. WordPress also lets anyone who can edit a post write unprotected
 * meta through its custom-field inputs and XML-RPC, with none of ACF's
 * checks. So the names the field groups store are protected meta, which
 * closes WordPress's own paths (ACF's editor and update_field() do not go
 * through them), and get_field() does not return a value that has no field
 * behind it.
 */

if (!defined('ABSPATH')) {
  exit();
}

/**
 * The post meta the registered field groups store: each top-level field's
 * name, and the `name_` prefix the rows and sub fields of a repeater,
 * flexible content or group field are stored under.
 *
 * @return array{names: array<string, true>, prefixes: string[]}
 */
function patronage_fields_stored_meta(): array {
  static $stored = null;
  if ($stored !== null) {
    return $stored;
  }

  $found = ['names' => [], 'prefixes' => []];
  if (!function_exists('acf_get_local_field_groups') || !did_action('acf/init')) {
    return $found;
  }
  foreach (acf_get_local_field_groups() as $group) {
    foreach (acf_get_local_fields($group['key']) as $field) {
      $name = (string) ($field['name'] ?? '');
      if ($name === '') {
        continue;
      }
      $found['names'][$name] = true;
      if (acf_get_local_fields($field['key'])) {
        $found['prefixes'][] = $name . '_';
      }
    }
  }

  // Field groups register during acf/init, so the list is complete, and
  // worth keeping, only once that has finished.
  if (!doing_action('acf/init')) {
    $stored = $found;
  }
  return $found;
}

/** Whether a post meta key holds a value of one of the field groups. */
function patronage_fields_is_field_meta(string $meta_key): bool {
  $stored = patronage_fields_stored_meta();
  if (isset($stored['names'][$meta_key])) {
    return true;
  }
  foreach ($stored['prefixes'] as $prefix) {
    if (str_starts_with($meta_key, $prefix)) {
      return true;
    }
  }
  return false;
}

add_filter(
  'is_protected_meta',
  function ($protected, $meta_key, $meta_type) {
    if ($protected || $meta_type !== 'post' || !is_string($meta_key)) {
      return $protected;
    }
    return patronage_fields_is_field_meta($meta_key);
  },
  10,
  3,
);

// Meta written without ACF has no field reference beside it. get_field()
// would return it as stored; with this it returns null. Write field values
// with update_field(), as seed/seed.php does.
add_filter('acf/prevent_access_to_unknown_fields', '__return_true');
