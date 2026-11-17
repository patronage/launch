<?php
/**
 * Locks WPGraphQL down to the queries the front-end sends.
 *
 * WPGraphQL Smart Cache runs in "only allowed" mode: signed-out callers can
 * run only documents saved as allowed persisted queries, by query ID, and
 * nobody can save new ones through Automatic Persisted Queries. The settings
 * are forced here, so they live in git rather than in the database.
 *
 * The allowed documents are graphql-documents.json, which apps/web-wordpress
 * writes from its GraphQL documents (`pnpm --filter web-wordpress documents`).
 * When the file changes, the next front-end request registers what is
 * missing; `wp patronage-headless documents` does it at once.
 *
 * Administrators (manage_options) are exempt, so GraphiQL still works for them.
 */

use WPGraphQL\SmartCache\Document;
use WPGraphQL\SmartCache\Document\Grant;
use WPGraphQL\SmartCache\Utils;

if (!defined('ABSPATH')) {
  exit();
}

const PATRONAGE_HEADLESS_DOCUMENTS_HASH = 'patronage_headless_graphql_documents_hash';
const PATRONAGE_HEADLESS_DOCUMENTS_LOCK = 'patronage_headless_graphql_documents_lock';

add_filter(
  'graphql_get_setting_section_fields',
  function ($fields, string $section) {
    if ($section === 'graphql_persisted_queries_section') {
      // The stored section is not always an array: WPGraphQL creates the
      // option as an empty string the first time wp-admin loads, and it only
      // becomes an array when someone saves the settings tab.
      $fields = is_array($fields) ? $fields : [];
      $fields['grant_mode'] = 'only_allowed';
      $fields['apq_auto_persist_mode'] = 'off';
    }
    return $fields;
  },
  10,
  2,
);

function patronage_headless_documents_file(): string {
  return get_template_directory() . '/graphql-documents.json';
}

/** Allows a document, throwing when the grant is not saved: Grant::save() reports failure by return value. */
function patronage_headless_allow_document(int $post_id): void {
  $saved = (new Grant())->save($post_id, Grant::ALLOW);
  if (!$saved || is_wp_error($saved)) {
    throw new RuntimeException(
      'allow grant ' . (is_wp_error($saved) ? $saved->get_error_message() : 'not saved'),
    );
  }
}

/**
 * Saves each missing document as an allowed persisted query under its query
 * ID. A document saved earlier without a grant (a failed run) is allowed now;
 * one whose grant someone set in the admin is left alone.
 *
 * @param array<int, array{name?: string, id?: string, query?: string}> $documents
 * @return array{created: string[], granted: string[], existing: string[], failed: array<string, string>}
 */
function patronage_headless_register_documents(array $documents): array {
  $result = ['created' => [], 'granted' => [], 'existing' => [], 'failed' => []];

  foreach ($documents as $document) {
    $name = (string) ($document['name'] ?? '');
    $id = (string) ($document['id'] ?? '');
    $query = (string) ($document['query'] ?? '');
    if ($name === '' || $id === '' || $query === '') {
      $result['failed'][$name ?: '(unnamed)'] = 'missing name, id or query';
      continue;
    }

    try {
      $post = Utils::getPostByTermName($id, Document::TYPE_NAME, Document::ALIAS_TAXONOMY_NAME);
      if ($post) {
        if (Grant::getQueryGrantSetting($post->ID) === Grant::USE_DEFAULT) {
          patronage_headless_allow_document($post->ID);
          $result['granted'][] = $name;
        } else {
          $result['existing'][] = $name;
        }
        continue;
      }

      $post_id = (new Document())->save($id, $query);
      // Document::save() marks rows as automatically persisted; these are deliberate.
      delete_post_meta($post_id, Document::SOURCE_META_KEY);
      patronage_headless_allow_document($post_id);
      $result['created'][] = $name;
    } catch (Throwable $error) {
      $result['failed'][$name] = $error->getMessage();
    }
  }

  return $result;
}

/**
 * Registers graphql-documents.json when it has changed since the last complete
 * registration. Returns null when there was nothing to do.
 */
function patronage_headless_sync_documents(bool $force = false): ?array {
  // Smart Cache hooks document saves only outside wp-admin.
  if (!class_exists(Document::class) || (!$force && is_admin())) {
    return null;
  }

  $file = patronage_headless_documents_file();
  $hash = is_readable($file) ? md5_file($file) : false;
  if (!$hash || (!$force && get_option(PATRONAGE_HEADLESS_DOCUMENTS_HASH) === $hash)) {
    return null;
  }
  // One request registers; the others carry on until it finishes.
  if (!$force && get_transient(PATRONAGE_HEADLESS_DOCUMENTS_LOCK)) {
    return null;
  }
  set_transient(PATRONAGE_HEADLESS_DOCUMENTS_LOCK, 1, MINUTE_IN_SECONDS);

  $documents = json_decode((string) file_get_contents($file), true);
  $result = is_array($documents)
    ? patronage_headless_register_documents($documents)
    : [
      'created' => [],
      'granted' => [],
      'existing' => [],
      'failed' => ['graphql-documents.json' => 'not a JSON list'],
    ];

  if ($result['failed']) {
    error_log('Patronage headless documents failed: ' . wp_json_encode($result['failed']));
    // Retry a failing document every few minutes, not on every request.
    set_transient(PATRONAGE_HEADLESS_DOCUMENTS_LOCK, 1, 5 * MINUTE_IN_SECONDS);
    return $result;
  }
  update_option(PATRONAGE_HEADLESS_DOCUMENTS_HASH, $hash);
  delete_transient(PATRONAGE_HEADLESS_DOCUMENTS_LOCK);
  return $result;
}

// Smart Cache registers its post type and taxonomies on init at the default priority.
add_action('init', 'patronage_headless_sync_documents', 99, 0);

/**
 * Keeps Smart Cache's documents out of multi-type content queries.
 * contentNodes without contentTypes includes every GraphQL post type, so
 * newly registered documents, which signed-out callers cannot see, could fill
 * a page of results and leave it empty.
 */
add_filter('graphql_post_object_connection_query_args', function ($query_args) {
  $types = $query_args['post_type'] ?? null;
  if (class_exists(Document::class) && is_array($types) && count($types) > 1) {
    $query_args['post_type'] = array_values(array_diff($types, [Document::TYPE_NAME]));
  }
  return $query_args;
});

if (defined('WP_CLI') && WP_CLI) {
  /**
   * Registers graphql-documents.json as allowed persisted queries now.
   *
   * @when after_wp_load
   */
  WP_CLI::add_command('patronage-headless documents', function (): void {
    $result = patronage_headless_sync_documents(true);
    if ($result === null) {
      WP_CLI::error('WPGraphQL Smart Cache is not active, or graphql-documents.json is missing');
    }
    foreach (['created', 'granted', 'existing'] as $key) {
      WP_CLI::log(ucfirst($key) . ': ' . (implode(', ', $result[$key]) ?: 'none'));
    }
    if ($result['failed']) {
      WP_CLI::error('Failed: ' . wp_json_encode($result['failed']));
    }
    WP_CLI::success('Documents registered.');
  });
}
