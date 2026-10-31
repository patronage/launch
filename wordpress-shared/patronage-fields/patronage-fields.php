<?php
/**
 * Patronage Fields: the ACF field groups and post types both Launch WordPress
 * installs share, so the headless and Timber sites edit the same content.
 *
 * Field groups are PHP files in fields/, written with Extended ACF
 * (vinkla/extended-acf) with the builders in field-helpers.php, and loaded on
 * acf/init; post types are in post-types.php, written with Extended CPTs.
 * Field JSON is neither loaded nor saved, so editing fields in wp-admin
 * changes nothing. rich-text-blocks.php registers the rich-text shortcodes,
 * and forms.php reads Formidable forms and saves their entries.
 *
 * WordPress loads only top-level mu-plugin files: each install commits a
 * one-line wp-content/mu-plugins/patronage-fields.php that requires this
 * file from the folder beside it (bind-mounted by Docker, copied by
 * bin/build.sh for deploys).
 */

if (!defined('ABSPATH')) {
  exit();
}

// Extended ACF, Extended CPTs (and Timber, where installed) are Composer
// libraries, installed into wp-content/plugins/composer-libs with the plugins.
$patronage_fields_autoload = WP_CONTENT_DIR . '/plugins/composer-libs/autoload.php';
if (is_readable($patronage_fields_autoload)) {
  require_once $patronage_fields_autoload;
}

require_once __DIR__ . '/post-types.php';
require_once __DIR__ . '/rich-text-blocks.php';
require_once __DIR__ . '/forms.php';

add_filter('acf/settings/load_json', '__return_empty_array');
add_filter('acf/settings/save_json', '__return_false');

add_action('acf/init', function (): void {
  if (!function_exists('register_extended_field_group')) {
    error_log('Extended ACF is missing: run composer install in the WordPress app');
    return;
  }
  require_once __DIR__ . '/field-helpers.php';
  foreach (glob(__DIR__ . '/fields/*.php') ?: [] as $file) {
    require_once $file;
  }
});
