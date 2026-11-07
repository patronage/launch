<?php
/**
 * Patronage Headless theme. WordPress here is an editing tool and a GraphQL
 * API; apps/web-wordpress renders the site. The field groups, post types,
 * rich-text shortcodes and form handling come from
 * wordpress-shared/patronage-fields, loaded as an mu-plugin.
 */

if (!defined('ABSPATH')) {
  exit();
}

require_once __DIR__ . '/inc/frontend.php';
require_once __DIR__ . '/inc/preview.php';
require_once __DIR__ . '/inc/forms-api.php';
require_once __DIR__ . '/inc/persisted-queries.php';
require_once __DIR__ . '/inc/cache-tags.php';

add_action('after_setup_theme', function (): void {
  add_theme_support('title-tag');
  add_theme_support('post-thumbnails');
  register_nav_menus(['primary' => 'Primary']);
});
