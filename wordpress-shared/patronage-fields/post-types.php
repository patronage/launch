<?php
/**
 * Post types and their admin list columns, defined in PHP with Extended CPTs
 * (johnbillion/extended-cpts, a Composer library loaded by patronage-fields.php).
 *
 * Register a new post type here with register_extended_post_type() on init;
 * set 'show_in_graphql', 'graphql_single_name' and 'graphql_plural_name' so
 * WPGraphQL exposes it. Pages and posts are built in, so Extended CPTs only
 * extends them (it skips registering a post type that exists); their labels
 * are passed back in so it keeps them.
 */

if (!defined('ABSPATH')) {
  exit();
}

/** Columns every list shares, after the title. */
function patronage_fields_admin_cols_base(): array {
  return [
    'title' => 'title',
    'author' => 'author',
    'modified' => [
      'title' => 'Last modified',
      'post_field' => 'post_modified',
      'date_format' => 'M j, Y g:i a',
    ],
  ];
}

/** Adds list columns to a post type that is already registered. */
function patronage_fields_extend_post_type(string $post_type, array $admin_cols): void {
  $object = get_post_type_object($post_type);
  if (!$object || !function_exists('register_extended_post_type')) {
    return;
  }

  register_extended_post_type(
    $post_type,
    [
      'labels' => (array) $object->labels,
      'admin_cols' => $admin_cols,
      'dashboard_glance' => false,
      'dashboard_activity' => false,
    ],
    ['singular' => $object->labels->singular_name, 'plural' => $object->labels->name],
  );
}

add_action(
  'init',
  function (): void {
    patronage_fields_extend_post_type('page', [
      ...patronage_fields_admin_cols_base(),
      'sections' => [
        'title' => 'Sections',
        // ACF stores a flexible content field as the list of its rows' layouts.
        'function' => function () {
          $layouts = get_post_meta(get_the_ID(), 'sections', true);
          echo esc_html((string) (is_array($layouts) ? count($layouts) : 0));
        },
      ],
    ]);

    patronage_fields_extend_post_type('post', [
      ...patronage_fields_admin_cols_base(),
      'categories' => ['taxonomy' => 'category', 'sortable' => false],
      'published' => [
        'title' => 'Published',
        'post_field' => 'post_date',
        'default' => 'DESC',
      ],
    ]);
  },
  // After WordPress registers its own post types.
  20,
);
