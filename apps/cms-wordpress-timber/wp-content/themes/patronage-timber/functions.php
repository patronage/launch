<?php
/**
 * Patronage Timber theme. WordPress renders the site itself here: Twig views
 * in views/ draw the shared Page Builder sections and heroes with the
 * @launch/ui design tokens. The field groups and post types come from
 * wordpress-shared/patronage-fields, loaded as an mu-plugin.
 */

if (!defined('ABSPATH')) {
  exit();
}

require_once __DIR__ . '/inc/timber.php';
require_once __DIR__ . '/inc/assets.php';
require_once __DIR__ . '/inc/content.php';
require_once __DIR__ . '/inc/forms.php';
require_once __DIR__ . '/inc/rich-text.php';
require_once __DIR__ . '/inc/render.php';

add_action('after_setup_theme', function (): void {
  add_theme_support('title-tag');
  add_theme_support('post-thumbnails');
  add_theme_support('html5', ['search-form', 'gallery', 'caption', 'style', 'script']);
  register_nav_menus(['primary' => 'Primary']);
});

// Posts live under /news/ (bin/seed.sh sets the permalink structure), and so
// does their list, without a page standing in for it.
add_action('init', function (): void {
  add_rewrite_rule('^news/?$', 'index.php?post_type=post', 'top');
  add_rewrite_rule('^news/page/([0-9]+)/?$', 'index.php?post_type=post&paged=$matches[1]', 'top');
});
