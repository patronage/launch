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
 * select fields come back as one-item lists.
 */

use Extended\ACF\Fields\ButtonGroup;
use Extended\ACF\Fields\FlexibleContent;
use Extended\ACF\Fields\Group;
use Extended\ACF\Fields\Image;
use Extended\ACF\Fields\Layout;
use Extended\ACF\Fields\Link;
use Extended\ACF\Fields\Repeater;
use Extended\ACF\Fields\Tab;
use Extended\ACF\Fields\Text;
use Extended\ACF\Fields\Textarea;
use Extended\ACF\Fields\TrueFalse;
use Extended\ACF\Fields\WYSIWYGEditor;
use Extended\ACF\Location;

if (!defined('ABSPATH')) {
  exit();
}

/** Every layout's section options, in a tab after its content. */
function patronage_headless_section_options(): array {
  $spacing = ['none' => 'None', 'sm' => 'Small', 'md' => 'Medium', 'lg' => 'Large'];

  return [
    Tab::make('Section options', 'section_options_tab'),
    Group::make('Section options', 'section_options')
      ->layout('block')
      ->fields([
        ButtonGroup::make('Skin', 'skin')
          ->choices(['light' => 'Light', 'dark' => 'Dark', 'accent' => 'Accent'])
          ->default('light')
          ->format('value')
          ->wrapper(['width' => 50]),
        ButtonGroup::make('Width', 'width')
          ->choices(['narrow' => 'Narrow', 'default' => 'Default', 'wide' => 'Wide', 'full' => 'Full'])
          ->default('default')
          ->format('value')
          ->wrapper(['width' => 50]),
        ButtonGroup::make('Padding top', 'padding_top')
          ->choices($spacing)
          ->default('md')
          ->format('value')
          ->wrapper(['width' => 50]),
        ButtonGroup::make('Padding bottom', 'padding_bottom')
          ->choices($spacing)
          ->default('md')
          ->format('value')
          ->wrapper(['width' => 50]),
        Text::make('Anchor', 'anchor')
          ->helperText('Links to this section as #anchor. Turned into lowercase words joined by hyphens.')
          ->wrapper(['width' => 50]),
        TrueFalse::make('Hidden', 'hidden')
          ->helperText('Kept in the editor and in previews, left off the published page.')
          ->stylized()
          ->wrapper(['width' => 50]),
      ]),
  ];
}

/** Buttons under a section's text. */
function patronage_headless_links(): Repeater {
  return Repeater::make('Links', 'links')
    ->layout('table')
    ->button('Add link')
    ->maxRows(3)
    ->fields([
      Link::make('Link', 'link')->format('array')->required(),
      ButtonGroup::make('Variant', 'variant')
        ->choices(['primary' => 'Primary', 'secondary' => 'Secondary', 'text' => 'Text'])
        ->default('primary')
        ->format('value'),
    ]);
}

function patronage_headless_image(string $label, string $name): Image {
  return Image::make($label, $name)->format('array')->previewSize('medium')->library('all');
}

function patronage_headless_layout(string $label, string $name, array $fields): Layout {
  return Layout::make($label, $name)
    ->layout('block')
    ->fields([Tab::make('Content', 'content_tab'), ...$fields, ...patronage_headless_section_options()]);
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
          WYSIWYGEditor::make('Body', 'body')->tabs('visual')->toolbar('basic')->disableMediaUpload(),
          patronage_headless_links(),
          ButtonGroup::make('Align', 'align')
            ->choices(['start' => 'Start', 'center' => 'Center'])
            ->default('start')
            ->format('value'),
        ]),
        patronage_headless_layout('Content and media', 'content_media', [
          Text::make('Eyebrow', 'eyebrow'),
          Text::make('Heading', 'heading'),
          WYSIWYGEditor::make('Body', 'body')->tabs('visual')->toolbar('basic')->disableMediaUpload(),
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
          WYSIWYGEditor::make('Body', 'body')->tabs('visual')->toolbar('basic')->disableMediaUpload(),
          patronage_headless_links(),
        ]),
      ]),
  ],
]);
