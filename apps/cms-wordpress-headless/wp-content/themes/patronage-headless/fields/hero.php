<?php
/**
 * Hero: an optional eyebrow, headline, intro and call to action above the
 * title of a page or post.
 */

use Extended\ACF\Fields\Link;
use Extended\ACF\Fields\Text;
use Extended\ACF\Fields\Textarea;
use Extended\ACF\Location;

if (!defined('ABSPATH')) {
  exit();
}

register_extended_field_group([
  'title' => 'Hero',
  'key' => 'patronage_headless_hero',
  'show_in_graphql' => true,
  'graphql_field_name' => 'hero',
  'map_graphql_types_from_location_rules' => true,
  'position' => 'acf_after_title',
  'style' => 'default',
  'location' => [Location::where('post_type', '==', 'page'), Location::where('post_type', '==', 'post')],
  'fields' => [
    Text::make('Eyebrow', 'eyebrow'),
    Text::make('Headline', 'headline')->helperText('Defaults to the title.'),
    Textarea::make('Intro', 'intro')->rows(3),
    Link::make('Call to action', 'cta')->format('array'),
  ],
]);
