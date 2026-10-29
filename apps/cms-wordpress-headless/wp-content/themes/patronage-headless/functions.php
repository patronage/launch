<?php
/**
 * Patronage Headless theme. WordPress here is an editing tool and a GraphQL
 * API; apps/web-wordpress renders the site.
 */

if (!defined('ABSPATH')) {
  exit();
}

require_once __DIR__ . '/inc/frontend.php';
require_once __DIR__ . '/inc/preview.php';
require_once __DIR__ . '/inc/fields.php';

add_action('after_setup_theme', function (): void {
  add_theme_support('title-tag');
  add_theme_support('post-thumbnails');
  register_nav_menus(['primary' => 'Primary']);
});
