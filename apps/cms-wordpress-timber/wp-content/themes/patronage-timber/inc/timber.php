<?php
/**
 * Starts Timber and fills the context every view gets: the site, the primary
 * menu and the front page's path.
 *
 * Timber and Twig are Composer libraries in wp-content/plugins/composer-libs,
 * whose autoloader the patronage-fields mu-plugin loads before any theme code.
 */

if (!defined('ABSPATH')) {
  exit();
}

if (!class_exists(\Timber\Timber::class)) {
  // Without Timber there is no site to draw; say so rather than a blank page.
  add_action('template_redirect', function (): void {
    wp_die('Timber is missing: run composer install in apps/cms-wordpress-timber.', 'Timber missing', 500);
  });
  return;
}

\Timber\Timber::init();
\Timber\Timber::$dirname = ['views'];

add_filter('timber/context', function (array $context): array {
  $context['menu'] = \Timber\Timber::get_menu('primary');
  $context['home_url'] = home_url('/');
  return $context;
});

/**
 * Twig autoescapes everything by default. Rich text is the one thing views
 * print raw, through the `rich` filter, after WordPress has filtered it.
 */
add_filter('timber/twig/environment/options', function (array $options): array {
  $options['autoescape'] = 'html';
  return $options;
});
