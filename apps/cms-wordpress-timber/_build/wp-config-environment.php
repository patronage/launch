<?php
// Environment block for a hosted wp-config.php, the Timber install's version of
// apps/cms-wordpress-headless/_build/wp-config-environment.php.
//
// Paste it into each Cloudways environment's wp-config.php, above "That's all,
// stop editing!", in place of the stock WP_DEBUG lines. Deploys never ship
// wp-config.php, so this file is a sample, not deployed code.

// Cloudways: the application folder (public_html's parent) names the environment.
$site_env_markers = [
  'production-app-folder' => 'production',
  'staging-app-folder' => 'staging',
];
$site_env = $site_env_markers[basename(dirname(__DIR__))] ?? 'production';

if (!defined('WP_ENVIRONMENT_TYPE')) {
  define('WP_ENVIRONMENT_TYPE', $site_env);
}

$site_env_config = [
  'production' => [
    'WP_DEBUG' => false,
    // Logging (mu-plugins/patronage-logging.php, from wordpress-shared). Off
    // unless both are set; packages/logging's provision script prints them.
    // 'PATRONAGE_LOGGING_ENDPOINT' => 'https://<stream id>.ingest.cloudflare.com',
    // 'PATRONAGE_LOGGING_TOKEN' => 'Basin send-only token',
    // Host log files to ship too (Cloudways keeps them in ../logs):
    // 'PATRONAGE_LOGGING_FILES' => [dirname(ABSPATH) . '/logs/*.log'],
  ],
  'staging' => [
    'WP_DEBUG' => true,
    'WP_DEBUG_LOG' => true,
    'WP_DEBUG_DISPLAY' => false,
  ],
];
foreach ($site_env_config[WP_ENVIRONMENT_TYPE] ?? [] as $site_env_name => $site_env_value) {
  if (!defined($site_env_name)) {
    define($site_env_name, $site_env_value);
  }
}
