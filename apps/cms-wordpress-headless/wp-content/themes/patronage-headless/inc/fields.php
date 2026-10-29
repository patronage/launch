<?php
/**
 * Field groups the front-end queries, registered in PHP so they live in git.
 * They use ACF (free) field types only.
 */

if (!defined('ABSPATH')) {
  exit();
}

add_action('acf/include_fields', function (): void {
  if (!function_exists('acf_add_local_field_group')) {
    return;
  }

  acf_add_local_field_group([
    'key' => 'group_patronage_headless_hero',
    'title' => 'Hero',
    'show_in_graphql' => true,
    'graphql_field_name' => 'hero',
    'map_graphql_types_from_location_rules' => true,
    'position' => 'acf_after_title',
    'location' => [
      [['param' => 'post_type', 'operator' => '==', 'value' => 'page']],
      [['param' => 'post_type', 'operator' => '==', 'value' => 'post']],
    ],
    'fields' => [
      [
        'key' => 'field_patronage_headless_hero_eyebrow',
        'label' => 'Eyebrow',
        'name' => 'eyebrow',
        'type' => 'text',
        'show_in_graphql' => true,
        'graphql_field_name' => 'eyebrow',
      ],
      [
        'key' => 'field_patronage_headless_hero_headline',
        'label' => 'Headline',
        'name' => 'headline',
        'type' => 'text',
        'instructions' => 'Defaults to the title.',
        'show_in_graphql' => true,
        'graphql_field_name' => 'headline',
      ],
      [
        'key' => 'field_patronage_headless_hero_intro',
        'label' => 'Intro',
        'name' => 'intro',
        'type' => 'textarea',
        'rows' => 3,
        'new_lines' => '',
        'show_in_graphql' => true,
        'graphql_field_name' => 'intro',
      ],
      [
        'key' => 'field_patronage_headless_hero_cta',
        'label' => 'Call to action',
        'name' => 'cta',
        'type' => 'link',
        'return_format' => 'array',
        'show_in_graphql' => true,
        'graphql_field_name' => 'cta',
      ],
    ],
  ]);
});
