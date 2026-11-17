<?php

declare(strict_types=1);

// The Timber theme's page model (inc/content.php and the form section in
// inc/forms.php) against WordPress stubs, fed the pages that
// packages/adapter-wordpress/fixtures records from the headless install. The
// fixtures are WPGraphQL's answers, so each is turned back into the ACF
// values get_field() returns (snake_case keys, `acf_fc_layout`, attachment
// IDs) before the theme reads it. The theme should draw the same sections
// the vinext adapter does.

define('ABSPATH', __DIR__);

/** @var array<int, array{src: string, alt: string, width: int, height: int, caption: string}> */
$test_attachments = [];
/** @var array<int, array<string, mixed>> */
$test_fields = [];
/** @var array<int, string> */
$test_titles = [];
/** @var array<string, array> */
$test_forms = [];
$test_permalink = 'https://cms.example.com/get-involved/';

function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {}
function remove_accents(string $text): string {
  return $text;
}
function wp_strip_all_tags(string $text): string {
  return trim(strip_tags($text));
}
function wp_parse_url(string $url): array|false {
  return parse_url($url);
}
function home_url(string $path = ''): string {
  return 'https://cms.example.com' . $path;
}
// Stands in for WordPress: keeps http(s) and site paths, drops other protocols.
function esc_url_raw(string $url): string {
  return preg_match('#^(https?://|/)#i', $url) ? $url : '';
}
function wp_unslash(mixed $value): mixed {
  return $value;
}
function add_query_arg(string|array $key, mixed $value = null, ?string $url = null): string {
  return $url . (str_contains((string) $url, '?') ? '&' : '?') . $key . '=' . $value;
}
function get_permalink(): string {
  global $test_permalink;
  return $test_permalink;
}
function get_field(string $name, int $post_id): mixed {
  global $test_fields;
  return $test_fields[$post_id][$name] ?? null;
}
function get_the_title(int $post_id): string {
  global $test_titles;
  return $test_titles[$post_id] ?? '';
}
function wp_get_attachment_image_src(int $id, string $size = 'thumbnail'): array|false {
  global $test_attachments;
  $attachment = $test_attachments[$id] ?? null;
  return $attachment ? [$attachment['src'], $attachment['width'], $attachment['height'], false] : false;
}
function wp_get_attachment_image_srcset(int $id, string $size = 'medium'): string|false {
  return false;
}
function get_post_meta(int $id, string $key, bool $single = false): mixed {
  global $test_attachments;
  return $key === '_wp_attachment_image_alt' ? $test_attachments[$id]['alt'] ?? '' : '';
}
function wp_get_attachment_caption(int $id): string|false {
  global $test_attachments;
  return $test_attachments[$id]['caption'] ?? false;
}
// Stands in for wordpress-shared/patronage-fields/forms.php.
function patronage_fields_form_model(int $id): ?array {
  global $test_forms;
  return $test_forms[(string) $id] ?? null;
}

$theme = dirname(__DIR__) . '/wp-content/themes/patronage-timber';
require $theme . '/inc/content.php';
require $theme . '/inc/forms.php';

$failures = 0;
function check(string $label, mixed $actual, mixed $expected): void {
  global $failures;
  if ($actual === $expected) {
    echo "ok    {$label}\n";
    return;
  }
  $failures++;
  echo "FAIL  {$label}\n      expected " . var_export($expected, true) . "\n      actual   " . var_export($actual, true) . "\n";
}

// From a WPGraphQL fixture to ACF values.

function snake(string $name): string {
  return strtolower((string) preg_replace('/(?<!^)[A-Z]/', '_$0', $name));
}

/** A WPGraphQL MediaItem edge as an attachment ID, registering the attachment. */
function attachment(?array $edge): ?int {
  global $test_attachments;
  $node = $edge['node'] ?? null;
  if (!$node) {
    return null;
  }
  $id = count($test_attachments) + 100;
  $test_attachments[$id] = [
    'src' => $node['sourceUrl'],
    'alt' => (string) $node['altText'],
    'width' => (int) $node['mediaDetails']['width'],
    'height' => (int) $node['mediaDetails']['height'],
    'caption' => trim(strip_tags((string) $node['caption'])),
  ];
  return $id;
}

/** WPGraphQL's camelCase fields as ACF's snake_case ones, images as IDs. */
function acf(mixed $value): mixed {
  if (!is_array($value)) {
    return $value;
  }
  if (array_key_exists('node', $value) && count($value) === 1) {
    return attachment($value['node'] === null ? null : $value);
  }
  $out = [];
  foreach ($value as $key => $item) {
    if ($key === '__typename') {
      $out['acf_fc_layout'] = snake((string) preg_replace('/^PageBuilderSections|Layout$/', '', $item));
    } elseif ($key === 'form' && is_array($item)) {
      global $test_forms;
      $test_forms[$item['id']] = $item;
      $out['form_id'] = $item['id'];
    } else {
      $out[is_int($key) ? $key : snake($key)] = acf($item);
    }
  }
  return $out;
}

function load_fixture(string $name, int $post_id): void {
  global $test_fields, $test_titles;
  $json = file_get_contents(dirname(__DIR__, 3) . "/packages/adapter-wordpress/fixtures/{$name}.json");
  $page = json_decode((string) $json, true)['data']['page'];
  $test_titles[$post_id] = $page['title'];
  $test_fields[$post_id] = acf($page['hero']) + ['sections' => acf($page['pageBuilder']['sections'])];
}

load_fixture('home', 1);
load_fixture('get-involved', 2);
load_fixture('guide', 3);

// Home: no hero, every layout, a hidden section and an unknown layout.
$home = patronage_timber_page(1);
$sections = $home['sections'];
$block = fn(int $index) => $sections[$index]['block'] ?? [];

check('a page without a hero variant has no hero', [$home['hero'], $home['heroSkin'], $home['heroJoinsNext']], [null, null, false]);
check(
  'maps every known layout in order, dropping hidden sections and the unknown layout',
  array_map(fn($section) => [$section['block']['id'], $section['block']['type']], $sections),
  [
    ['section-0', 'content'],
    ['section-1', 'contentMedia'],
    ['section-2', 'cardGrid'],
    ['section-3', 'blockquote'],
    ['section-4', 'media'],
    ['section-5', 'callToAction'],
  ],
);
check(
  'a preview keeps the hidden section',
  array_map(fn($section) => [$section['block']['id'], $section['options']['hidden']], array_slice(patronage_timber_page(1, true)['sections'], -1)),
  [['section-6', true]],
);
check(
  'reads section options and slugifies the anchor',
  $sections[0]['options'],
  ['skin' => 'accent', 'width' => 'narrow', 'paddingTop' => 'lg', 'paddingBottom' => 'lg', 'hidden' => false, 'slug' => 'intro'],
);
check('leaves the slug out of a section without an anchor', array_key_exists('slug', $sections[1]['options']), false);
check(
  'the first of two sections with the same skin drops its bottom padding',
  array_map(fn($section) => $section['options']['paddingBottom'], $sections),
  ['lg', 'none', 'md', 'lg', 'none', 'md'],
);
check(
  'without a hero, the first section opens with the h1',
  array_column($sections, 'headingLevel'),
  ['h1', 'h2', 'h2', 'h2', 'h2', 'h2'],
);
check(
  'a content section keeps its copy and alignment',
  [$block(0)['eyebrow'] ?? null, $block(0)['heading'] ?? null, $block(0)['body'] ?? null, $block(0)['align'] ?? null],
  ['Neighborhood Growers', 'Grow food together', "<p>We help neighbors turn empty lots into <strong>shared gardens</strong>.</p>", 'center'],
);
check(
  'makes links to this site relative and keeps other links whole',
  $block(0)['links'] ?? null,
  [
    ['label' => 'Get involved', 'href' => '/get-involved/', 'newTab' => false, 'variant' => 'primary'],
    ['label' => 'Garden map', 'href' => 'https://maps.example.org/gardens', 'newTab' => true, 'variant' => 'secondary'],
  ],
);
check(
  'a content and media section carries its image, caption and position',
  [$block(1)['media'] ?? null, $block(1)['mediaPosition'] ?? null, array_key_exists('eyebrow', $block(1)), $block(1)['links'] ?? null],
  [
    [
      'image' => ['id' => $block(1)['media']['image']['id'] ?? 0, 'src' => 'https://cms.example.com/wp-content/uploads/2026/10/raised-beds.jpg', 'alt' => 'Raised garden beds in a city lot', 'width' => 1600, 'height' => 1067],
      'caption' => 'Raised beds on a former parking lot',
    ],
    'end',
    false,
    [],
  ],
);
check('a card grid reads its column count as a number', $block(2)['columns'] ?? null, 3);
check(
  'cards keep what they have and link as text links',
  array_map(fn($card) => [$card['id'], $card['title'], $card['link']['href'] ?? null, $card['link']['variant'] ?? null, isset($card['image'])], $block(2)['cards'] ?? []),
  [
    ['section-2-0', 'Seed library', '/programs/seed-library/', 'text', true],
    ['section-2-1', 'Tool share', '/programs/tool-share/', 'text', true],
    ['section-2-2', 'Youth growers', null, null, false],
  ],
);
check(
  'a blockquote keeps its attribution, role and portrait',
  [$block(3)['quote'] ?? null, $block(3)['attribution'] ?? null, $block(3)['role'] ?? null, $block(3)['image']['alt'] ?? null],
  ["The garden is the first place on our block where everyone knows each other's names.", 'Rosa Delgado', 'Garden lead', 'Portrait of Rosa'],
);
check('a media section takes the attachment caption as text', $block(4)['media']['caption'] ?? null, 'Fall harvest day');
check(
  'a call to action keeps its heading and links',
  [$block(5)['heading'] ?? null, array_column($block(5)['links'] ?? [], 'href')],
  ['Start a garden on your block', ['/apply/']],
);

// Get involved: a split hero and a form section.
$_GET = [];
$involved = patronage_timber_page(2);
$hero = $involved['hero'];
check(
  'a split hero takes the page title when its own is empty',
  [$hero['variant'] ?? null, $hero['title'] ?? null, $hero['eyebrow'] ?? null, $hero['skin'] ?? null, $hero['align'] ?? null],
  ['split', 'Get involved', 'Volunteer', 'light', 'start'],
);
check('a split hero keeps its subhead, image and links', [isset($hero['subhead']), $hero['image']['width'] ?? null, array_column($hero['links'] ?? [], 'href')], [true, 2400, ['/get-involved/']]);
check('a hero joins a first section with its skin', [$involved['heroSkin'], $involved['heroJoinsNext']], ['light', true]);
check('with a hero, every section opens with an h2', array_column($involved['sections'], 'headingLevel'), ['h2', 'h2']);

$form = $involved['sections'][0]['block'] ?? [];
check('a form section draws its Formidable form', [$form['type'] ?? null, $form['heading'] ?? null, $form['form']['id'] ?? null], ['form', 'Volunteer with us', '3']);
check(
  'the form posts back to its page and names its hidden fields',
  [$form['form']['action'] ?? null, $form['form']['idField'] ?? null, $form['form']['honeypot'] ?? null],
  ['https://cms.example.com/get-involved/#form-3', 'patronage_form_id', 'patronage_form_website'],
);
check('the form is not sent, and has no error or values, on a plain visit', [$form['form']['sent'] ?? null, array_key_exists('error', $form['form'] ?? []) ? $form['form']['error'] : 'unset', $form['form']['values'] ?? null], [false, null, []]);
check(
  'the form keeps the fields of its model',
  array_column($form['form']['fields'] ?? [], 'name'),
  ['name', 'email', 'interest', 'note', 'newsletter'],
);

$_GET = ['form-sent' => '3'];
check('the form shows as sent after its redirect', patronage_timber_page(2)['sections'][0]['block']['form']['sent'] ?? null, true);
$_GET = ['form-sent' => '4'];
check("another form's redirect does not mark it sent", patronage_timber_page(2)['sections'][0]['block']['form']['sent'] ?? null, false);

$_GET = ['form-sent' => '3'];
patronage_timber_form_result(['id' => '3', 'error' => 'email must be an email address.', 'values' => ['name' => 'Reader', 'email' => 'reader']]);
$failed = patronage_timber_page(2)['sections'][0]['block']['form'] ?? [];
check(
  'a failed submission shows its error and keeps the values, and is not sent',
  [$failed['error'] ?? null, $failed['values'] ?? null, $failed['sent'] ?? null],
  ['email must be an email address.', ['name' => 'Reader', 'email' => 'reader'], false],
);
$_GET = [];

$test_forms = [];
check('a form section whose form is missing is dropped', array_column(array_column(patronage_timber_page(2)['sections'], 'block'), 'type'), ['callToAction']);

// The starter guide: a free-form hero.
$guide = patronage_timber_hero(3);
check(
  'a free-form hero keeps rich body text instead of a subhead',
  [$guide['variant'] ?? null, $guide['title'] ?? null, $guide['align'] ?? null, isset($guide['subhead']), str_contains($guide['body'] ?? '', 'soil test')],
  ['freeform', 'Your first season', 'center', false, true],
);

// Form values posted to the page.
$model = [
  'fields' => [
    ['type' => 'text', 'name' => 'name'],
    ['type' => 'checkbox', 'name' => 'newsletter'],
    ['type' => 'checkbox', 'name' => 'terms'],
    ['type' => 'message', 'name' => ''],
    ['type' => 'select', 'name' => 'interest'],
  ],
];
$_POST = ['fields' => ['name' => 'Reader', 'newsletter' => 'on', 'interest' => ['Harvest days'], 'isAdmin' => '1', '' => 'x']];
check(
  "reads posted values for the form's own fields, ticks as true and false, and arrays as empty",
  patronage_timber_form_values($model),
  ['name' => 'Reader', 'newsletter' => 'true', 'terms' => 'false', 'interest' => ''],
);
$_POST = ['fields' => 'not-an-array'];
check('reads nothing from fields that are not an array', patronage_timber_form_values($model), ['name' => '', 'newsletter' => 'false', 'terms' => 'false', 'interest' => '']);
$_POST = [];

// The smaller mappers on their own.
check('a link with a javascript: URL is dropped', patronage_timber_link(['url' => 'javascript:alert(1)', 'title' => 'Go']), null);
check('a link without a label is dropped', patronage_timber_link(['url' => '/apply/', 'title' => '  ']), null);
check('an unknown link variant falls back to primary', patronage_timber_link(['url' => '/apply/', 'title' => 'Apply'], 'loud')['variant'] ?? null, 'primary');
check('a link to this host on another port stays whole', patronage_timber_href('https://cms.example.com:8443/apply/'), 'https://cms.example.com:8443/apply/');
check('a link to this site keeps its query and fragment', patronage_timber_href('https://cms.example.com/apply/?step=2#form'), '/apply/?step=2#form');
check('rich text without text or embeds is empty', patronage_timber_rich("<p> </p>\n"), null);
check('rich text holding only an image is kept', patronage_timber_rich('<p><img src="/a.jpg" alt=""></p>'), '<p><img src="/a.jpg" alt=""></p>');
check('a blockquote without a quote is dropped', patronage_timber_block(['acf_fc_layout' => 'blockquote', 'quote' => ' '], 'section-0'), null);
check('a media section without an image is dropped', patronage_timber_block(['acf_fc_layout' => 'media', 'media' => 999], 'section-0'), null);
check(
  'section options outside their choices fall back to the defaults',
  patronage_timber_section_options(['skin' => 'neon', 'width' => ['full'], 'padding_top' => 'xl', 'anchor' => '  ']),
  ['skin' => 'light', 'width' => 'full', 'paddingTop' => 'md', 'paddingBottom' => 'md', 'hidden' => false],
);

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
