<?php
/**
 * The theme's stylesheet and fonts. dist/main.css is Tailwind's build of
 * assets/main.css (`pnpm --filter cms-wordpress-timber build:css`), which
 * imports @launch/ui's tokens and theme, so the site matches the vinext
 * front-ends without sharing their components.
 */

if (!defined('ABSPATH')) {
  exit();
}

/** The faces tokens.css names, as @launch/ui's FontLinks loads them. */
const PATRONAGE_TIMBER_FONTS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=JetBrains+Mono:wght@400;500&display=swap';

add_action('wp_enqueue_scripts', function (): void {
  wp_enqueue_style('patronage-timber-fonts', PATRONAGE_TIMBER_FONTS, [], null);

  $css = get_template_directory() . '/dist/main.css';
  if (!is_readable($css)) {
    error_log('patronage-timber: dist/main.css is missing; run pnpm --filter cms-wordpress-timber build:css');
    return;
  }
  wp_enqueue_style(
    'patronage-timber',
    get_template_directory_uri() . '/dist/main.css',
    ['patronage-timber-fonts'],
    (string) filemtime($css),
  );

  // The theme draws its own blocks; WordPress's block styles would fight Tailwind's.
  wp_dequeue_style('wp-block-library');
  wp_dequeue_style('classic-theme-styles');
}, 20);

// theme.json presets and emoji scripts the site never uses.
remove_action('wp_enqueue_scripts', 'wp_enqueue_global_styles');
remove_action('wp_footer', 'wp_enqueue_global_styles', 1);
remove_action('wp_body_open', 'wp_global_styles_render_svg_filters');
remove_action('wp_head', 'print_emoji_detection_script', 7);
remove_action('wp_print_styles', 'print_emoji_styles');
remove_action('wp_enqueue_scripts', 'wp_enqueue_emoji_styles');

add_filter('wp_resource_hints', function (array $urls, string $relation): array {
  if ($relation === 'preconnect') {
    $urls[] = 'https://fonts.googleapis.com';
    $urls[] = ['href' => 'https://fonts.gstatic.com', 'crossorigin' => ''];
  }
  return $urls;
}, 10, 2);
