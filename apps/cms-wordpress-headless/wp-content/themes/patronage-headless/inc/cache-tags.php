<?php
/**
 * Sends WPGraphQL Smart Cache purges to the front-end as cache tags.
 *
 * apps/web-wordpress tags each cached read with the Smart Cache keys in its
 * X-GraphQL-Keys header: node keys (global IDs), list:<type> and
 * skipped:<type>. Whenever Smart Cache purges a key (graphql_purge), this
 * queues it as a tag with the patronage-headless-revalidate mu-plugin, so an
 * edit expires only the reads and pages that showed the changed post, term,
 * menu or setting. graphql:Query and "Purge Cache Now" purge everything, and
 * go out as `wordpress`, the tag on every read.
 *
 * The mu-plugin still sends each changed post's paths, which also replace a
 * cached "not found" at a new URL.
 */

if (!defined('ABSPATH')) {
  exit();
}

/** The tag on every front-end read of WordPress (WORDPRESS_CACHE_TAG). */
const PATRONAGE_HEADLESS_CACHE_ALL_TAG = 'wordpress';

/**
 * A response Smart Cache serves from its object cache carries no node keys,
 * because no resolver runs. The front-end has its own cache, and asks only on
 * a miss, so turn the object cache off and keep every header complete.
 */
add_filter('graphql_cache_is_object_cache_enabled', '__return_false', PHP_INT_MAX);

/**
 * Smart Cache purges a settings group only for options registered with
 * register_setting(), which core does on admin_init and rest_api_init. Do it
 * for WP-CLI too, so `wp option update blogname` reaches the front-end.
 */
if (defined('WP_CLI') && WP_CLI) {
  add_action('init', 'register_initial_settings');
}

if (function_exists('patronage_headless_revalidate_queue_tags')) {
  add_action(
    'graphql_purge',
    function ($key): void {
      if (is_string($key) && $key !== '') {
        patronage_headless_revalidate_queue_tags([
          $key === 'graphql:Query' ? PATRONAGE_HEADLESS_CACHE_ALL_TAG : $key,
        ]);
      }
    },
    10,
    1,
  );

  add_action('wpgraphql_cache_purge_all', function (): void {
    patronage_headless_revalidate_queue_tags([PATRONAGE_HEADLESS_CACHE_ALL_TAG]);
  });

  // Smart Cache purges each changed post's own keys above. The mu-plugin's
  // default per-post tag is `wordpress`, which would expire every page.
  add_filter('patronage_headless_revalidate_post_tags', '__return_empty_array');
}
