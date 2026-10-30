<?php
/**
 * Plugin Name: Patronage Headless Revalidate
 * Description: Tells the headless front-end to revalidate a page when its WordPress content is published, edited, renamed, unpublished or trashed.
 * Version: 2.1.0
 * Author: Patronage
 *
 * It does nothing until this environment's wp-config.php defines the first
 * two constants. Each environment has its own front-end:
 *
 *   PATRONAGE_REVALIDATE_URL     the front-end origin, e.g. https://www.example.org
 *   PATRONAGE_REVALIDATE_SECRET  the secret the front-end's revalidate route checks
 *   PATRONAGE_REVALIDATE_ACCESS_ID      optional: a Cloudflare Access service token,
 *   PATRONAGE_REVALIDATE_ACCESS_SECRET  sent as CF-Access-Client-Id and -Secret to a
 *                                       front-end behind Access
 *
 * The request is PUT {paths, tags} to /api/revalidate/ with an
 * X-Headless-Secret-Key header, as apps/web-wordpress expects.
 *
 * Changes are queued during the request and sent in one request at shutdown.
 * Themes add their own with patronage_headless_revalidate_queue_paths() and
 * patronage_headless_revalidate_queue_tags(), and send early with patronage_headless_revalidate_flush().
 * `wp patronage-headless-revalidate verify` checks the whole round trip against the
 * front-end. See apps/cms-wordpress-headless/README.md.
 */

if (!defined('ABSPATH')) {
  exit();
}

const PATRONAGE_HEADLESS_REVALIDATE_VERSION = '2.1.0';
const PATRONAGE_HEADLESS_REVALIDATE_STATUS = 'patronage_headless_revalidate_last_send';

const PATRONAGE_HEADLESS_REVALIDATE_EMPTY = [
  'paths' => [],
  'tags' => [],
  'posts' => [],
  'before' => [],
];

/**
 * The queue for this request. A static, not a global: WP-CLI loads
 * mu-plugins inside a function, where a file-level variable is not global.
 *
 * paths and tags are sent as they are. posts holds the IDs of changed posts,
 * whose paths are worked out at send time, after the save has also written
 * the post's terms. before holds the URL each post had just before it
 * changed, to send if the post has moved since.
 *
 * @return array{paths: array<string, true>, tags: array<string, true>, posts: array<int, true>, before: array<int, string>}
 */
function &patronage_headless_revalidate_queue(): array {
  static $queue = PATRONAGE_HEADLESS_REVALIDATE_EMPTY;
  return $queue;
}

function patronage_headless_revalidate_configured(): bool {
  return defined('PATRONAGE_REVALIDATE_URL') &&
    PATRONAGE_REVALIDATE_URL &&
    defined('PATRONAGE_REVALIDATE_SECRET') &&
    PATRONAGE_REVALIDATE_SECRET;
}

function patronage_headless_revalidate_origin(): string {
  return untrailingslashit((string) PATRONAGE_REVALIDATE_URL);
}

/**
 * Both starter frontends set trailingSlash: true, so the route lives at the
 * slash form; a frontend without it can filter this to '/api/revalidate'.
 */
function patronage_headless_revalidate_endpoint(): string {
  return patronage_headless_revalidate_origin() .
    apply_filters('patronage_headless_revalidate_endpoint', '/api/revalidate/');
}

/**
 * The frontend path for a WordPress URL or path: no host or query, and no
 * trailing slash except on the home page. Both starters revalidate either
 * form under trailingSlash: true; one form keeps the queue free of duplicates.
 */
function patronage_headless_revalidate_path(string $url): string {
  $path = '/' . ltrim((string) wp_parse_url($url, PHP_URL_PATH), '/');
  // A WordPress URL from a subdirectory install (home at /wp) maps to the frontend root.
  if (wp_parse_url($url, PHP_URL_HOST)) {
    $home = untrailingslashit((string) wp_parse_url(home_url(), PHP_URL_PATH));
    if ($home !== '' && ($path === $home || str_starts_with($path, $home . '/'))) {
      $path = '/' . ltrim(substr($path, strlen($home)), '/');
    }
  }
  return $path === '/' ? '/' : untrailingslashit($path);
}

/**
 * The frontend path for a post's permalink, or '' for a plain permalink
 * (?p=123), which has no path of its own. Headless frontends route by path,
 * so a site without pretty permalinks gets no post paths.
 */
function patronage_headless_revalidate_post_path(string $permalink): string {
  return $permalink === '' || wp_parse_url($permalink, PHP_URL_QUERY)
    ? ''
    : patronage_headless_revalidate_path($permalink);
}

/** Queues frontend paths (or full WordPress URLs) to revalidate at shutdown. */
function patronage_headless_revalidate_queue_paths(array $paths): void {
  $queue = &patronage_headless_revalidate_queue();
  foreach ($paths as $path) {
    if (is_string($path) && $path !== '') {
      $queue['paths'][patronage_headless_revalidate_path($path)] = true;
    }
  }
}

/** Queues cache tags to revalidate at shutdown. */
function patronage_headless_revalidate_queue_tags(array $tags): void {
  $queue = &patronage_headless_revalidate_queue();
  foreach ($tags as $tag) {
    if (is_string($tag) && $tag !== '') {
      $queue['tags'][$tag] = true;
    }
  }
}

/**
 * Headers that get a request past a Cloudflare Access application in front
 * of the front-end. Sent with the revalidate request and with verify's page checks.
 */
function patronage_headless_revalidate_access_headers(): array {
  $headers = [];
  if (
    defined('PATRONAGE_REVALIDATE_ACCESS_ID') &&
    PATRONAGE_REVALIDATE_ACCESS_ID &&
    defined('PATRONAGE_REVALIDATE_ACCESS_SECRET') &&
    PATRONAGE_REVALIDATE_ACCESS_SECRET
  ) {
    $headers['cf-access-client-id'] = PATRONAGE_REVALIDATE_ACCESS_ID;
    $headers['cf-access-client-secret'] = PATRONAGE_REVALIDATE_ACCESS_SECRET;
  }
  return $headers;
}

function patronage_headless_revalidate_log(string $message): void {
  error_log('Patronage headless revalidate: ' . $message);
}

/**
 * Sends the queue now and empties it. Logs and stores the paths, tags and
 * response code, never the request, whose body or headers carry the secret.
 *
 * @return array{ok: bool, status: int, message: string, paths: string[], tags: string[]}
 */
function patronage_headless_revalidate_flush(): array {
  patronage_headless_revalidate_resolve_posts();
  $queue = &patronage_headless_revalidate_queue();
  $paths = array_keys($queue['paths']);
  $tags = array_keys($queue['tags']);
  $queue = PATRONAGE_HEADLESS_REVALIDATE_EMPTY;

  $result = ['paths' => $paths, 'tags' => $tags];
  if (!$paths && !$tags) {
    return $result + ['ok' => true, 'status' => 0, 'message' => 'Nothing queued'];
  }
  if (!patronage_headless_revalidate_configured()) {
    $message = 'PATRONAGE_REVALIDATE_URL or PATRONAGE_REVALIDATE_SECRET is not defined';
    return $result + ['ok' => false, 'status' => 0, 'message' => $message];
  }

  $headers = [
    'content-type' => 'application/json',
    'x-headless-secret-key' => PATRONAGE_REVALIDATE_SECRET,
  ];
  $headers += patronage_headless_revalidate_access_headers();

  $response = wp_remote_request(patronage_headless_revalidate_endpoint(), [
    'method' => 'PUT',
    'timeout' => 10,
    // A redirect (a trailing-slash mismatch, a sign-in page) would turn the
    // PUT into a GET that answers 200 without revalidating anything.
    'redirection' => 0,
    'headers' => $headers,
    'body' => wp_json_encode(['paths' => $paths, 'tags' => $tags]),
  ]);
  if (is_wp_error($response)) {
    $result += ['ok' => false, 'status' => 0, 'message' => $response->get_error_message()];
  } else {
    $status = (int) wp_remote_retrieve_response_code($response);
    $location = (string) wp_remote_retrieve_header($response, 'location');
    $result += [
      'ok' => $status >= 200 && $status < 300,
      'status' => $status,
      'message' =>
        $status >= 300 && $status < 400
          ? "The frontend redirected to {$location}; check PATRONAGE_REVALIDATE_URL, the Access constants, or the patronage_headless_revalidate_endpoint filter"
          : ($status === 401
            ? 'The frontend refused PATRONAGE_REVALIDATE_SECRET'
            : "HTTP {$status}"),
    ];
  }

  patronage_headless_revalidate_log(
    ($result['ok'] ? 'sent' : 'failed') .
      ($result['status'] ? " (HTTP {$result['status']})" : ": {$result['message']}") .
      ' paths=' .
      wp_json_encode($paths, JSON_UNESCAPED_SLASHES) .
      ' tags=' .
      wp_json_encode($tags),
  );
  update_option(PATRONAGE_HEADLESS_REVALIDATE_STATUS, $result + ['at' => time()], false);
  return $result;
}

// Late, so cache purges that other code runs at shutdown (WPGraphQL Smart
// Cache, a theme's CDN purge) land before the frontend refetches. On PHP-FPM
// the editor gets its response first, instead of waiting up to the 10 s
// timeout for the frontend. WP-CLI has no response to finish.
add_action(
  'shutdown',
  function (): void {
    $queue = &patronage_headless_revalidate_queue();
    if ($queue === PATRONAGE_HEADLESS_REVALIDATE_EMPTY) {
      return;
    }
    if (
      function_exists('fastcgi_finish_request') &&
      !(defined('WP_CLI') && WP_CLI) &&
      patronage_headless_revalidate_configured()
    ) {
      fastcgi_finish_request();
    }
    patronage_headless_revalidate_flush();
  },
  PHP_INT_MAX,
);

/** Whether a post's changes show on the frontend at a URL of its own. */
function patronage_headless_revalidate_post_is_public(WP_Post $post): bool {
  return !wp_is_post_revision($post) &&
    !wp_is_post_autosave($post) &&
    $post->post_type !== 'attachment' &&
    is_post_type_viewable($post->post_type);
}

/** The permalink the post has, or had, while published. */
function patronage_headless_revalidate_published_permalink(WP_Post $post): string {
  // A post that is not published has no pretty permalink; ask for the one it had.
  $published = clone $post;
  $published->post_status = 'publish';
  if ($post->post_status === 'trash') {
    // Trashing renames the slug to "<slug>__trashed" before the status hooks run.
    $slug = get_post_meta($post->ID, '_wp_desired_post_slug', true);
    if ($slug) {
      $published->post_name = $slug;
    }
  }
  return (string) get_permalink($published);
}

function patronage_headless_revalidate_queue_post(WP_Post $post): void {
  $queue = &patronage_headless_revalidate_queue();
  $queue['posts'][$post->ID] = true;
  patronage_headless_revalidate_queue_tags(
    (array) apply_filters('patronage_headless_revalidate_post_tags', ['wordpress'], $post),
  );
}

/**
 * Records the URL a published post, and each published descendant of a
 * hierarchical one, has before a change, so a slug, parent or term change
 * that moves it sends the old path too. Only the first record per request
 * counts: it is the URL the frontend has cached.
 */
function patronage_headless_revalidate_remember(WP_Post $post): void {
  $queue = &patronage_headless_revalidate_queue();
  $queue['before'][$post->ID] ??= (string) get_permalink($post);
  if (!is_post_type_hierarchical($post->post_type)) {
    return;
  }
  $parents = [$post->ID];
  while ($parents) {
    $children = get_posts([
      'post_type' => $post->post_type,
      'post_status' => 'publish',
      'post_parent__in' => $parents,
      'post__not_in' => array_keys($queue['before']),
      'posts_per_page' => -1,
      'no_found_rows' => true,
    ]);
    $parents = [];
    foreach ($children as $child) {
      $queue['before'][$child->ID] ??= (string) get_permalink($child);
      $parents[] = $child->ID;
    }
  }
}

/** Turns queued posts into paths, now that the saves that queued them are complete. */
function patronage_headless_revalidate_resolve_posts(): void {
  $queue = &patronage_headless_revalidate_queue();
  $paths = [];
  foreach (array_keys($queue['posts']) as $post_id) {
    $post = get_post($post_id);
    // An unpublished or trashed post with a recorded URL is sent from that
    // record below; its own permalink may already carry the __trashed slug.
    if ($post && ($post->post_status === 'publish' || !isset($queue['before'][$post_id]))) {
      $paths[] = patronage_headless_revalidate_post_path(
        patronage_headless_revalidate_published_permalink($post),
      );
    }
  }
  foreach ($queue['before'] as $post_id => $old) {
    $post = get_post($post_id);
    $new = $post && $post->post_status === 'publish' ? (string) get_permalink($post) : '';
    if ($new !== $old) {
      // Moved, unpublished, trashed or deleted: the old path must stop serving it,
      // and a descendant's new path may hold a cached 404.
      $paths[] = patronage_headless_revalidate_post_path($old);
      $paths[] = patronage_headless_revalidate_post_path($new);
    }
  }
  $queue['posts'] = [];
  $queue['before'] = [];
  patronage_headless_revalidate_queue_paths(array_filter($paths));
}

// Published, edited, unpublished or trashed. Scheduled posts publish under
// cron, so DOING_CRON is not skipped.
add_action(
  'transition_post_status',
  function (string $new_status, string $old_status, WP_Post $post): void {
    if (
      ($new_status === 'publish' || $old_status === 'publish') &&
      patronage_headless_revalidate_post_is_public($post)
    ) {
      patronage_headless_revalidate_queue_post($post);
    }
  },
  10,
  3,
);

// Before the database row and the post's terms change. A slug, parent or
// %category% change moves a published post and its descendants. Trashing
// renames the slug before pre_post_update runs, so wp_trash_post, which runs
// first, records the URL for a trash.
$patronage_headless_revalidate_remember_published = function (int $post_id): void {
  $post = get_post($post_id);
  if (
    $post &&
    $post->post_status === 'publish' &&
    patronage_headless_revalidate_post_is_public($post)
  ) {
    patronage_headless_revalidate_remember($post);
  }
};
add_action('wp_trash_post', $patronage_headless_revalidate_remember_published);
add_action('pre_post_update', $patronage_headless_revalidate_remember_published);

// Deleting a published post without trashing it first fires no status change.
// Deleting a parent also moves its children up a level.
add_action(
  'before_delete_post',
  function (int $post_id, WP_Post $post): void {
    if ($post->post_status === 'publish' && patronage_headless_revalidate_post_is_public($post)) {
      patronage_headless_revalidate_remember($post);
      patronage_headless_revalidate_queue_post($post);
    }
  },
  10,
  2,
);

if (defined('WP_CLI') && WP_CLI) {
  /**
   * Checks or inspects revalidation of the headless frontend.
   */
  WP_CLI::add_command(
    'patronage-headless-revalidate',
    new class {
      /** Seconds each check retries; set from --wait. */
      private int $wait = 90;

      /**
       * Publishes, edits and trashes a test post, and checks the frontend after each.
       *
       * Creates a post with a unique slug and title, then checks that the
       * frontend serves it, serves the edited title after an edit, and answers
       * 404 once it is trashed. The post is always deleted afterwards. Exits
       * non-zero on any failure.
       *
       * Each check retries until it passes or --wait runs out, and reports how
       * long the change took to show. A frontend on Workers KV can take a few
       * seconds in the location that received the purge, and up to about a
       * minute in other locations, because KV caches what it reads.
       *
       * Publishing a real post also runs everything else hooked to publishing:
       * search indexing, WPGraphQL Smart Cache list purges, sitemap pings,
       * social or newsletter auto-posting. So on production it runs only with
       * --yes.
       *
       * ## OPTIONS
       *
       * [--yes]
       * : Run on production anyway.
       *
       * [--post_type=<post_type>]
       * : The post type to test with.
       * ---
       * default: post
       * ---
       *
       * [--wait=<seconds>]
       * : How long each check retries before it fails.
       * ---
       * default: 90
       * ---
       *
       * @when after_wp_load
       */
      public function verify(array $args, array $assoc_args): void {
        if (
          wp_get_environment_type() === 'production' &&
          !WP_CLI\Utils\get_flag_value($assoc_args, 'yes', false)
        ) {
          WP_CLI::error(
            'This is production: verify publishes a real post, which also triggers search indexing, Smart Cache list purges, sitemap pings and any auto-posting. Pass --yes to run it anyway.',
          );
        }
        if (!patronage_headless_revalidate_configured()) {
          WP_CLI::error(
            'Not configured: define PATRONAGE_REVALIDATE_URL and PATRONAGE_REVALIDATE_SECRET',
          );
        }
        if (!get_option('permalink_structure')) {
          WP_CLI::error(
            'Pretty permalinks are off (Settings > Permalinks), so posts have no frontend path to check',
          );
        }
        $this->wait = max(0, (int) ($assoc_args['wait'] ?? 90));
        $token = 'HeadlessRevalidateVerify' . strtolower(wp_generate_password(12, false));
        $post_id = 0;
        $failure = null;
        try {
          $post_id = wp_insert_post(
            [
              'post_type' => $assoc_args['post_type'] ?? 'post',
              'post_status' => 'publish',
              'post_title' => $token,
              'post_name' => strtolower($token),
              'post_content' =>
                'Created by wp patronage-headless-revalidate verify. It deletes this post when it finishes.',
            ],
            true,
          );
          if (is_wp_error($post_id)) {
            throw new RuntimeException(
              'Could not create the test post: ' . $post_id->get_error_message(),
            );
          }
          $permalink = (string) get_permalink($post_id);
          $path = patronage_headless_revalidate_path($permalink);
          $url =
            patronage_headless_revalidate_origin() .
            $path .
            ($path !== '/' && str_ends_with($permalink, '/') ? '/' : '');
          WP_CLI::log("Test post {$post_id}: {$url}");

          $this->flush('publish');
          $this->expect($url, 200, $token);

          $edited = $token . 'Edited';
          wp_update_post(['ID' => $post_id, 'post_title' => $edited]);
          $this->flush('edit');
          $this->expect($url, 200, $edited);

          wp_trash_post($post_id);
          $this->flush('trash');
          $this->expect($url, 404);
        } catch (RuntimeException $e) {
          $failure = $e->getMessage();
        } finally {
          if ($post_id && !is_wp_error($post_id)) {
            // Trash first if a check failed early, so the frontend drops the page.
            if (get_post_status($post_id) === 'publish') {
              wp_trash_post($post_id);
            }
            wp_delete_post($post_id, true);
            patronage_headless_revalidate_flush();
          }
        }
        $failure
          ? WP_CLI::error($failure)
          : WP_CLI::success('Publish, edit and trash all reached the frontend.');
      }

      /**
       * Prints the configuration and the last send.
       */
      public function status(): void {
        $last = get_option(PATRONAGE_HEADLESS_REVALIDATE_STATUS);
        WP_CLI::line('Environment: ' . wp_get_environment_type());
        WP_CLI::line(
          'Frontend:    ' .
            (defined('PATRONAGE_REVALIDATE_URL') ? PATRONAGE_REVALIDATE_URL : '(not defined)'),
        );
        WP_CLI::line(
          'Secret:      ' . (defined('PATRONAGE_REVALIDATE_SECRET') ? 'defined' : '(not defined)'),
        );
        WP_CLI::line(
          'Access ID:   ' .
            (defined('PATRONAGE_REVALIDATE_ACCESS_ID') ? 'defined' : '(not defined)'),
        );
        WP_CLI::line(
          'Access key:  ' .
            (defined('PATRONAGE_REVALIDATE_ACCESS_SECRET') ? 'defined' : '(not defined)'),
        );
        WP_CLI::line(
          'Endpoint:    ' .
            (defined('PATRONAGE_REVALIDATE_URL')
              ? patronage_headless_revalidate_endpoint()
              : '(not defined)'),
        );
        WP_CLI::line(
          'Last send:   ' .
            (is_array($last)
              ? gmdate('Y-m-d H:i:s', $last['at']) .
                ' UTC, ' .
                ($last['ok'] ? 'ok' : 'failed') .
                ($last['status'] ? " (HTTP {$last['status']})" : '') .
                ($last['ok'] ? '' : ": {$last['message']}") .
                ', paths ' .
                implode(' ', $last['paths'])
              : '(none)'),
        );
      }

      private function flush(string $step): void {
        $result = patronage_headless_revalidate_flush();
        if (!$result['ok'] || !$result['status']) {
          throw new RuntimeException("Revalidate after {$step} failed: {$result['message']}");
        }
        WP_CLI::log(
          "Revalidated after {$step} (HTTP {$result['status']}): " . implode(' ', $result['paths']),
        );
      }

      /** Retries the check every two seconds until it passes or $this->wait runs out. */
      private function expect(string $url, int $status, string $text = ''): void {
        $started = microtime(true);
        while (true) {
          $problem = $this->check($url, $status, $text);
          $elapsed = microtime(true) - $started;
          if ($problem === null) {
            WP_CLI::log(
              "GET {$url}: {$status}" .
                ($text !== '' ? ", shows {$text}" : '') .
                sprintf(' (after %.1f s)', $elapsed),
            );
            return;
          }
          if ($elapsed >= $this->wait) {
            throw new RuntimeException(sprintf('%s, still after %.0f s', $problem, $elapsed));
          }
          sleep(2);
        }
      }

      /** Null when the URL answers as expected, otherwise what it answered. */
      private function check(string $url, int $status, string $text): ?string {
        $response = wp_remote_get($url, [
          'timeout' => 30,
          'headers' => patronage_headless_revalidate_access_headers(),
        ]);
        if (is_wp_error($response)) {
          return "GET {$url} failed: " . $response->get_error_message();
        }
        $actual = (int) wp_remote_retrieve_response_code($response);
        if ($actual !== $status) {
          return "GET {$url} answered {$actual}, expected {$status}";
        }
        if ($text !== '' && strpos(wp_remote_retrieve_body($response), $text) === false) {
          return "GET {$url} answered {$status} without \"{$text}\"";
        }
        return null;
      }
    },
  );
}
