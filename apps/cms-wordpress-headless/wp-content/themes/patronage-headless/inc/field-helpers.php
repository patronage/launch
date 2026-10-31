<?php
/**
 * Field builders shared by the field groups in fields/, loaded by
 * inc/fields.php before them.
 */

use Extended\ACF\Fields\ButtonGroup;
use Extended\ACF\Fields\Group;
use Extended\ACF\Fields\Image;
use Extended\ACF\Fields\Layout;
use Extended\ACF\Fields\Link;
use Extended\ACF\Fields\Repeater;
use Extended\ACF\Fields\Tab;
use Extended\ACF\Fields\Text;
use Extended\ACF\Fields\TrueFalse;
use Extended\ACF\Fields\WYSIWYGEditor;

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

/**
 * Rich text. Buttons, images, pullquotes and embeds go in as the shortcodes
 * in inc/rich-text-blocks.php.
 */
function patronage_headless_body(string $label = 'Body', string $name = 'body'): WYSIWYGEditor {
  return WYSIWYGEditor::make($label, $name)
    ->tabs('visual')
    ->toolbar('basic')
    ->disableMediaUpload()
    ->helperText(
      'Add blocks with shortcodes: [launch_button url="/apply" label="Apply" variant="primary"], [launch_image id="12"], [launch_pullquote attribution="Name"]Quote[/launch_pullquote], [launch_embed url="https://www.youtube.com/watch?v=…"].',
    );
}
