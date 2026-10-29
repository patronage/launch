<?php
/**
 * Loads the ACF field groups in fields/, written with Extended ACF
 * (vinkla/extended-acf), so field definitions live in git as PHP. Field JSON
 * is neither loaded nor saved: editing fields in wp-admin changes nothing.
 *
 * Extended ACF is a Composer library, installed into
 * wp-content/plugins/composer-libs with the plugins.
 */

if (!defined('ABSPATH')) {
  exit();
}

$patronage_headless_autoload = WP_CONTENT_DIR . '/plugins/composer-libs/autoload.php';
if (is_readable($patronage_headless_autoload)) {
  require_once $patronage_headless_autoload;
}

add_filter('acf/settings/load_json', '__return_empty_array');
add_filter('acf/settings/save_json', '__return_false');

add_action('acf/init', function (): void {
  if (!function_exists('register_extended_field_group')) {
    error_log('Extended ACF is missing: run composer install in apps/cms-wordpress-headless');
    return;
  }
  foreach (glob(get_template_directory() . '/fields/*.php') ?: [] as $file) {
    require_once $file;
  }
});
