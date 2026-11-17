<?php
// Environment block for a hosted wp-config.php, adapted from launch-wordpress's
// _init/wp-config-environment.php for the headless install.
//
// Paste it into each Cloudways environment's wp-config.php, above "That's all,
// stop editing!", in place of the stock WP_DEBUG lines. The block is the same in
// every environment; only the values differ. Deploys never ship wp-config.php,
// so this file is a sample, not deployed code. Keep the real values in the
// password manager, never in git.

// Cloudways: the application folder (public_html's parent) names the environment.
$site_env_markers = [
  'production-app-folder' => 'production',
  'staging-app-folder' => 'staging',
];
$site_env = $site_env_markers[basename(dirname(__DIR__))] ?? 'production';

if (!defined('WP_ENVIRONMENT_TYPE')) {
  define('WP_ENVIRONMENT_TYPE', $site_env);
}

// Values that differ by environment. Each environment has its own front-end
// Worker, so its own secret and Access applications.
$site_env_config = [
  'production' => [
    'WP_DEBUG' => false,

    // The front-end (apps/web-wordpress). Editors are sent there, and Preview
    // opens there. HEADLESS_SECRET must match the Worker's secret of that name:
    // it signs preview links and authenticates revalidation.
    'HEADLESS_FRONTEND_URL' => 'https://www.example.org',
    'HEADLESS_SECRET' => 'the front-end Worker HEADLESS_SECRET',

    // Revalidation (mu-plugins/patronage-headless-revalidate.php).
    'PATRONAGE_REVALIDATE_URL' => 'https://www.example.org',
    'PATRONAGE_REVALIDATE_SECRET' => 'the front-end Worker HEADLESS_SECRET',
    // Only when the front-end is behind Access: a service token it accepts.
    // 'PATRONAGE_REVALIDATE_ACCESS_ID' => 'service token client ID',
    // 'PATRONAGE_REVALIDATE_ACCESS_SECRET' => 'service token client secret',

    // Access lockdown (mu-plugins/patronage-access.php, from wordpress-shared).
    // packages/access/scripts/provision-access.ts prints the team domain and AUDs.
    // 'PATRONAGE_ACCESS_TEAM_DOMAIN' => 'https://team.cloudflareaccess.com',
    // 'PATRONAGE_ACCESS_AUD' => 'gateway (preview) application AUD',
    // 'PATRONAGE_ACCESS_REQUIRE_ORIGIN_JWT' => true,
    // 'PATRONAGE_ACCESS_ORIGIN_AUD' => 'CMS application AUD',
    // Signs editors in to wp-admin from their Access login, and after logout
    // offers "Sign in with Access as <email>" (patronage-access 1.1.0+).
    // 'PATRONAGE_ACCESS_BROWSER_LOGIN' => true,
    // 'PATRONAGE_ACCESS_PROOF_SECRET' => 'same value as the Worker secret',
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
    'HEADLESS_FRONTEND_URL' => 'https://staging.example.org',
    'HEADLESS_SECRET' => 'the staging front-end Worker HEADLESS_SECRET',
    'PATRONAGE_REVALIDATE_URL' => 'https://staging.example.org',
    'PATRONAGE_REVALIDATE_SECRET' => 'the staging front-end Worker HEADLESS_SECRET',
    // The Access constants, as in production, with staging's applications.
  ],
];
foreach ($site_env_config[WP_ENVIRONMENT_TYPE] ?? [] as $site_env_name => $site_env_value) {
  if (!defined($site_env_name)) {
    define($site_env_name, $site_env_value);
  }
}
