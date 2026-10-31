<?php
/**
 * Page Builder: a page's sections, one flexible content row per section.
 *
 * Layouts, fields and choices are named after packages/content-model, and
 * after the same blocks in the Payload app, so the WordPress adapter only maps
 * what really differs between the CMSs: rich text, links and images. WPGraphQL
 * for ACF names each layout's type PageBuilderSections<Layout>Layout, e.g.
 * content_media becomes PageBuilderSectionsContentMediaLayout.
 *
 * Choice fields are button groups, which WPGraphQL returns as a string;
 * select fields come back as one-item lists. Section options and the other
 * shared field builders are in inc/field-helpers.php.
 */

use Extended\ACF\Fields\ButtonGroup;
use Extended\ACF\Fields\FlexibleContent;
use Extended\ACF\Fields\Link;
use Extended\ACF\Fields\Repeater;
use Extended\ACF\Fields\Select;
use Extended\ACF\Fields\Text;
use Extended\ACF\Fields\Textarea;
use Extended\ACF\Location;

if (!defined('ABSPATH')) {
  exit();
}

register_extended_field_group([
  'title' => 'Page Builder',
  'key' => 'patronage_headless_page_builder',
  'show_in_graphql' => true,
  'graphql_field_name' => 'pageBuilder',
  'map_graphql_types_from_location_rules' => true,
  'position' => 'acf_after_title',
  'style' => 'seamless',
  'hide_on_screen' => ['the_content'],
  'location' => [Location::where('post_type', '==', 'page')],
  'fields' => [
    FlexibleContent::make('Sections', 'sections')
      ->button('Add section')
      ->layouts([
        patronage_headless_layout('Content', 'content', [
          Text::make('Eyebrow', 'eyebrow'),
          Text::make('Heading', 'heading'),
          patronage_headless_body(),
          patronage_headless_links(),
          ButtonGroup::make('Align', 'align')
            ->choices(['start' => 'Start', 'center' => 'Center'])
            ->default('start')
            ->format('value'),
        ]),
        patronage_headless_layout('Content and media', 'content_media', [
          Text::make('Eyebrow', 'eyebrow'),
          Text::make('Heading', 'heading'),
          patronage_headless_body(),
          patronage_headless_links(),
          patronage_headless_image('Media', 'media')
            ->helperText('The image caption, if any, is shown under it.')
            ->required(),
          ButtonGroup::make('Media position', 'media_position')
            ->choices(['start' => 'Start', 'end' => 'End'])
            ->default('end')
            ->format('value'),
        ]),
        patronage_headless_layout('Media', 'media', [
          patronage_headless_image('Media', 'media')
            ->helperText('The image caption, if any, is shown under it.')
            ->required(),
        ]),
        patronage_headless_layout('Card grid', 'card_grid', [
          Text::make('Heading', 'heading'),
          ButtonGroup::make('Columns', 'columns')
            ->choices(['2' => '2', '3' => '3', '4' => '4'])
            ->default('3')
            ->format('value'),
          Repeater::make('Cards', 'cards')
            ->layout('block')
            ->button('Add card')
            ->collapsed('title')
            ->fields([
              Text::make('Title', 'title')->required(),
              Textarea::make('Text', 'text')->rows(3)->helperText('Plain text.'),
              patronage_headless_image('Image', 'image'),
              Link::make('Link', 'link')->format('array'),
            ]),
        ]),
        patronage_headless_layout('Blockquote', 'blockquote', [
          Textarea::make('Quote', 'quote')->rows(4)->required()->helperText('Plain text.'),
          Text::make('Attribution', 'attribution')->wrapper(['width' => 50]),
          Text::make('Role', 'role')->wrapper(['width' => 50]),
          patronage_headless_image('Image', 'image'),
        ]),
        patronage_headless_layout('Call to action', 'call_to_action', [
          Text::make('Heading', 'heading')->required(),
          patronage_headless_body(),
          patronage_headless_links(),
        ]),
        patronage_headless_layout('Form', 'form', [
          Text::make('Heading', 'heading'),
          patronage_headless_body(),
          Select::make('Form', 'form_id')
            ->helperText('A form from Forms (Formidable). Its fields, button label and success message come from there.')
            ->format('value')
            ->required(),
        ]),
      ]),
  ],
]);
