<?php
/**
 * Hero: the top of a page or post, shaped after `Hero` in
 * packages/content-model and the Payload app's hero group. With no variant
 * there is no hero: a page opens with its first section's heading as the
 * <h1>, and a post with its title. Each variant shows only the
 * fields it draws, and the adapter ignores any left over from another.
 */

use Extended\ACF\ConditionalLogic;
use Extended\ACF\Fields\ButtonGroup;
use Extended\ACF\Fields\Select;
use Extended\ACF\Fields\Text;
use Extended\ACF\Fields\Textarea;
use Extended\ACF\Location;

if (!defined('ABSPATH')) {
  exit();
}

/** Conditional logic: shown when the variant is one of $variants. */
function patronage_fields_hero_for(string ...$variants): array {
  return array_map(fn(string $variant) => ConditionalLogic::where('variant', '==', $variant), $variants);
}

$patronage_fields_any_hero = patronage_fields_hero_for('home', 'split', 'media', 'simple', 'freeform');

register_extended_field_group([
  'title' => 'Hero',
  // The key predates this shared folder. ACF derives the stored field keys
  // from it, so changing it would orphan existing content.
  'key' => 'patronage_headless_hero',
  'show_in_graphql' => true,
  'graphql_field_name' => 'hero',
  'map_graphql_types_from_location_rules' => true,
  'position' => 'acf_after_title',
  'style' => 'default',
  'location' => [Location::where('post_type', '==', 'page'), Location::where('post_type', '==', 'post')],
  'fields' => [
    Select::make('Variant', 'variant')
      ->choices([
        'home' => 'Home (title over image)',
        'split' => 'Split (image beside)',
        'media' => 'Media (image below)',
        'simple' => 'Simple (no image)',
        'freeform' => 'Free-form (rich text)',
      ])
      ->nullable()
      ->format('value')
      ->helperText('Leave empty for no hero.'),
    Text::make('Title', 'title')
      ->helperText('Defaults to the page title.')
      ->conditionalLogic($patronage_fields_any_hero),
    Text::make('Eyebrow', 'eyebrow')
      ->wrapper(['width' => 50])
      ->conditionalLogic($patronage_fields_any_hero),
    ButtonGroup::make('Skin', 'skin')
      ->choices(['light' => 'Light', 'dark' => 'Dark', 'accent' => 'Accent'])
      ->default('light')
      ->format('value')
      ->wrapper(['width' => 25])
      ->conditionalLogic($patronage_fields_any_hero),
    ButtonGroup::make('Align', 'align')
      ->choices(['start' => 'Start', 'center' => 'Center'])
      ->default('start')
      ->format('value')
      ->wrapper(['width' => 25])
      ->conditionalLogic($patronage_fields_any_hero),
    Textarea::make('Subhead', 'subhead')
      ->rows(3)
      ->helperText('Plain text.')
      ->conditionalLogic(patronage_fields_hero_for('home', 'split', 'media', 'simple')),
    patronage_fields_body()->conditionalLogic(patronage_fields_hero_for('freeform')),
    patronage_fields_image('Image', 'image')->conditionalLogic(patronage_fields_hero_for('home', 'split', 'media')),
    patronage_fields_links()->conditionalLogic($patronage_fields_any_hero),
  ],
]);

/**
 * Moves heroes saved with the old fields (headline, intro, cta) to a simple
 * hero, once, so content entered before the variants keeps its hero. The old
 * values stay in post meta.
 */
add_action('init', function (): void {
  if ((int) get_option('patronage_headless_hero_version') >= 2) {
    return;
  }
  $ids = get_posts([
    'post_type' => ['page', 'post'],
    'post_status' => 'any',
    'numberposts' => -1,
    'fields' => 'ids',
    'meta_query' => [
      'relation' => 'OR',
      ['key' => 'headline', 'value' => '', 'compare' => '!='],
      ['key' => 'intro', 'value' => '', 'compare' => '!='],
      ['key' => 'cta', 'value' => '', 'compare' => '!='],
    ],
  ]);
  foreach ($ids as $id) {
    if (get_post_meta($id, 'variant', true)) {
      continue;
    }
    $cta = maybe_unserialize(get_post_meta($id, 'cta', true));
    update_field('variant', 'simple', $id);
    update_field('title', (string) get_post_meta($id, 'headline', true), $id);
    update_field('subhead', (string) get_post_meta($id, 'intro', true), $id);
    if (is_array($cta) && !empty($cta['url'])) {
      update_field('links', [['link' => $cta, 'variant' => 'primary']], $id);
    }
  }
  update_option('patronage_headless_hero_version', 2);
});
