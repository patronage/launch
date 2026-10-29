<?php
/**
 * Sends visitors of WordPress's own front-end to the headless front-end at
 * the same path. The admin, logins, REST, GraphQL, cron and WP-CLI are left alone.
 */

if (!defined('ABSPATH')) {
  exit();
}

/** The public front-end origin, or '' when HEADLESS_FRONTEND_URL is not defined. */
function patronage_headless_frontend_url(): string {
  return defined('HEADLESS_FRONTEND_URL') ? untrailingslashit((string) HEADLESS_FRONTEND_URL) : '';
}

add_action('template_redirect', function (): void {
  $frontend = patronage_headless_frontend_url();
  if ($frontend === '' || is_preview() || (function_exists('is_graphql_request') && is_graphql_request())) {
    return;
  }
  $path = (string) wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
  wp_redirect($frontend . $path, 302, 'Patronage Headless');
  exit();
});
