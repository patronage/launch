<?php
/**
 * Plugin Name: Patronage Fleet
 * Description: Reports this site's WordPress, plugin and theme versions to Patronage Fleet once a day, for the fleet vulnerability scan.
 * Version: 1.1.0
 * Author: Patronage
 *
 * Outbound only: the site posts a signed report and exposes no endpoint. It
 * does nothing outside production, or until production's wp-config.php
 * defines all four constants:
 *
 *   PATRONAGE_FLEET_SITE           the site's slug in Fleet
 *   PATRONAGE_FLEET_KEY            the Ed25519 seed from `fleet inventory keygen <slug>`
 *   PATRONAGE_FLEET_ACCESS_ID      the shared site-report Cloudflare Access
 *   PATRONAGE_FLEET_ACCESS_SECRET  service token
 *
 * The Access token gets the request to fleet's report path and nowhere else;
 * the signature proves which site sent it. Fleet holds only the public key, so
 * the key can sign reports for this one site and nothing else. See README.md
 * beside this file.
 */

if (!defined('ABSPATH')) {
  exit();
}

const PATRONAGE_FLEET_VERSION = '1.1.0';
const PATRONAGE_FLEET_HOOK = 'patronage_fleet_report';
const PATRONAGE_FLEET_STATUS = 'patronage_fleet_last_report';

const PATRONAGE_FLEET_CONSTANTS = [
  'PATRONAGE_FLEET_SITE',
  'PATRONAGE_FLEET_KEY',
  'PATRONAGE_FLEET_ACCESS_ID',
  'PATRONAGE_FLEET_ACCESS_SECRET',
];

function patronage_fleet_configured(): bool {
  foreach (PATRONAGE_FLEET_CONSTANTS as $name) {
    if (!defined($name) || !constant($name)) {
      return false;
    }
  }
  return wp_get_environment_type() === 'production' && function_exists('sodium_crypto_sign_detached');
}

function patronage_fleet_url(): string {
  return defined('PATRONAGE_FLEET_URL') ? PATRONAGE_FLEET_URL : 'https://fleet.patronage.com/api/inventory/report';
}

/**
 * Must-use plugins by slug. WordPress loads only top-level files in
 * mu-plugins/, so a plugin Composer installs into mu-plugins/<slug>/ runs
 * through a one-line loader file with no Version header; the version comes
 * from <slug>/<slug>.php instead. A folder without a loader is reported as
 * inactive.
 *
 * @return array<string, array{version: string, active: bool}>
 */
function patronage_fleet_mu_plugins(): array {
  $found = [];
  foreach (get_mu_plugins() as $file => $plugin) {
    $found[basename($file, '.php')] = ['version' => (string) $plugin['Version'], 'active' => true];
  }
  foreach (glob(WPMU_PLUGIN_DIR . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
    $slug = basename($dir);
    $main = "$dir/$slug.php";
    if (!is_readable($main)) {
      continue;
    }
    $version = (string) get_file_data($main, ['Version' => 'Version'])['Version'];
    if (!isset($found[$slug])) {
      $found[$slug] = ['version' => $version, 'active' => false];
    } elseif ($found[$slug]['version'] === '') {
      $found[$slug]['version'] = $version;
    }
  }
  ksort($found);
  return $found;
}

/** The same fields the fleet SSH probe reads, so fleet parses both alike. */
function patronage_fleet_inventory(): array {
  if (!function_exists('get_plugins')) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
  }
  $active = (array) get_option('active_plugins', []);
  if (is_multisite()) {
    $active = array_merge($active, array_keys((array) get_site_option('active_sitewide_plugins', [])));
  }
  $plugin_updates = get_site_transient('update_plugins');
  $plugins = [];
  foreach (get_plugins() as $file => $plugin) {
    $plugins[] = [
      'slug' => dirname($file) === '.' ? basename($file, '.php') : dirname($file),
      'version' => (string) $plugin['Version'],
      'active' => in_array($file, $active, true),
      'update' => is_object($plugin_updates) && isset($plugin_updates->response[$file])
        ? (string) $plugin_updates->response[$file]->new_version
        : null,
    ];
  }
  foreach (patronage_fleet_mu_plugins() as $slug => $plugin) {
    $plugins[] = [
      'slug' => $slug,
      'version' => $plugin['version'],
      'active' => $plugin['active'],
      'update' => null,
      'mu' => true,
    ];
  }
  $theme_updates = get_site_transient('update_themes');
  $themes = [];
  foreach (wp_get_themes() as $slug => $theme) {
    $themes[] = [
      'slug' => (string) $slug,
      'version' => (string) $theme->get('Version'),
      'active' => $slug === get_stylesheet() || $slug === get_template(),
      'update' => is_object($theme_updates) && isset($theme_updates->response[$slug])
        ? (string) $theme_updates->response[$slug]['new_version']
        : null,
    ];
  }
  return [
    'reporter' => PATRONAGE_FLEET_VERSION,
    'core' => get_bloginfo('version'),
    'home' => home_url(),
    'php' => PHP_VERSION,
    'multisite' => is_multisite(),
    'plugins' => $plugins,
    'themes' => $themes,
  ];
}

/**
 * Signs "<site>\n<timestamp>\n<body>" so fleet can check which site sent the
 * report, that the body is unchanged, and that it is recent.
 *
 * @return array{ok: bool, status: int, message: string}
 */
function patronage_fleet_send(): array {
  if (!patronage_fleet_configured()) {
    return ['ok' => false, 'status' => 0, 'message' => 'Not production, or a PATRONAGE_FLEET_* constant is missing'];
  }
  $seed = base64_decode(PATRONAGE_FLEET_KEY, true);
  if ($seed === false || strlen($seed) !== SODIUM_CRYPTO_SIGN_SEEDBYTES) {
    return ['ok' => false, 'status' => 0, 'message' => 'PATRONAGE_FLEET_KEY is not a base64 Ed25519 seed'];
  }
  $secret = sodium_crypto_sign_secretkey(sodium_crypto_sign_seed_keypair($seed));
  $body = wp_json_encode(patronage_fleet_inventory());
  $timestamp = (string) time();
  $signature = sodium_crypto_sign_detached(PATRONAGE_FLEET_SITE . "\n" . $timestamp . "\n" . $body, $secret);

  $response = wp_remote_post(patronage_fleet_url(), [
    'timeout' => 20,
    // Access answers a bad token with a redirect to its sign-in page; following
    // it would turn a rejected report into a 200.
    'redirection' => 0,
    'headers' => [
      'content-type' => 'application/json',
      'cf-access-client-id' => PATRONAGE_FLEET_ACCESS_ID,
      'cf-access-client-secret' => PATRONAGE_FLEET_ACCESS_SECRET,
      'x-fleet-site' => PATRONAGE_FLEET_SITE,
      'x-fleet-timestamp' => $timestamp,
      'x-fleet-signature' => base64_encode($signature),
    ],
    'body' => $body,
  ]);
  if (is_wp_error($response)) {
    $result = ['ok' => false, 'status' => 0, 'message' => $response->get_error_message()];
  } else {
    $status = (int) wp_remote_retrieve_response_code($response);
    $result = [
      'ok' => $status >= 200 && $status < 300,
      'status' => $status,
      'message' => $status >= 300 && $status < 400
        ? 'Cloudflare Access refused the service token (check PATRONAGE_FLEET_ACCESS_ID and _SECRET)'
        : substr(trim((string) wp_remote_retrieve_body($response)), 0, 300),
    ];
  }
  update_site_option(PATRONAGE_FLEET_STATUS, $result + ['at' => time()]);
  return $result;
}

add_action(PATRONAGE_FLEET_HOOK, 'patronage_fleet_send');

// One daily report per install. On multisite, only the main site schedules it;
// the report covers the whole network.
add_action('init', function () {
  if (!patronage_fleet_configured() || !is_main_site()) {
    return;
  }
  if (!wp_next_scheduled(PATRONAGE_FLEET_HOOK)) {
    // Spread first runs over the hour so the fleet doesn't report at once.
    wp_schedule_event(time() + wp_rand(60, HOUR_IN_SECONDS), 'daily', PATRONAGE_FLEET_HOOK);
  }
});

// Report again shortly after any core, plugin or theme update.
add_action('upgrader_process_complete', function () {
  if (patronage_fleet_configured() && !wp_next_scheduled(PATRONAGE_FLEET_HOOK . '_soon')) {
    wp_schedule_single_event(time() + 5 * MINUTE_IN_SECONDS, PATRONAGE_FLEET_HOOK . '_soon');
  }
});
add_action(PATRONAGE_FLEET_HOOK . '_soon', 'patronage_fleet_send');

if (defined('WP_CLI') && WP_CLI) {
  /**
   * Sends or inspects this site's fleet version report.
   */
  WP_CLI::add_command('patronage-fleet', new class {
    /**
     * Sends the report now and prints fleet's reply.
     */
    public function report(): void {
      $result = patronage_fleet_send();
      $line = $result['status'] ? "HTTP {$result['status']}: {$result['message']}" : $result['message'];
      $result['ok'] ? WP_CLI::success($line) : WP_CLI::error($line);
    }

    /**
     * Prints the configuration, the next scheduled report and the last result.
     */
    public function status(): void {
      $last = get_site_option(PATRONAGE_FLEET_STATUS);
      $next = wp_next_scheduled(PATRONAGE_FLEET_HOOK);
      WP_CLI::line('Environment: ' . wp_get_environment_type());
      WP_CLI::line('Site:        ' . (defined('PATRONAGE_FLEET_SITE') ? PATRONAGE_FLEET_SITE : '(not defined)'));
      foreach (array_slice(PATRONAGE_FLEET_CONSTANTS, 1) as $name) {
        WP_CLI::line(str_pad(substr($name, strlen('PATRONAGE_FLEET_')) . ':', 13) . (defined($name) ? 'defined' : '(not defined)'));
      }
      WP_CLI::line('Endpoint:    ' . patronage_fleet_url());
      WP_CLI::line('Next report: ' . ($next ? gmdate('Y-m-d H:i:s', $next) . ' UTC' : '(not scheduled)'));
      WP_CLI::line(
        'Last report: ' .
          (is_array($last)
            ? gmdate('Y-m-d H:i:s', $last['at']) . ' UTC, ' . ($last['ok'] ? 'ok' : 'failed') . ($last['status'] ? " (HTTP {$last['status']})" : '') . ($last['ok'] ? '' : ": {$last['message']}")
            : '(none)'),
      );
    }

    /**
     * Prints the JSON report without sending it.
     */
    public function inventory(): void {
      WP_CLI::line(wp_json_encode(patronage_fleet_inventory(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }
  });
}
