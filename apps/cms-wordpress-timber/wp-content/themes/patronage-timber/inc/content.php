<?php
/**
 * Maps a page's ACF fields to the shapes in packages/content-model (Hero,
 * Section, Block, Link, Image), so the Twig views read the same model the
 * vinext front-ends render, and stay free of ACF's field formats.
 *
 * Keys are the content model's (camelCase). Rich text stays WordPress's own:
 * a WYSIWYG field's formatted HTML, with the theme's shortcodes already run.
 */

if (!defined('ABSPATH')) {
  exit();
}

const PATRONAGE_TIMBER_SKINS = ['light', 'dark', 'accent'];
const PATRONAGE_TIMBER_WIDTHS = ['narrow', 'default', 'wide', 'full'];
const PATRONAGE_TIMBER_SPACINGS = ['none', 'sm', 'md', 'lg'];
const PATRONAGE_TIMBER_LINK_VARIANTS = ['primary', 'secondary', 'text'];
const PATRONAGE_TIMBER_HERO_VARIANTS = ['home', 'split', 'media', 'simple', 'freeform'];

/** `$value` if it is one of `$allowed`, else `$fallback` (content model's oneOf). */
function patronage_timber_one_of(array $allowed, mixed $value, string $fallback): string {
  $raw = is_array($value) ? ($value[0] ?? null) : $value;
  return in_array($raw, $allowed, true) ? (string) $raw : $fallback;
}

/** Lowercase, hyphenated anchor id, as the content model's slugify. */
function patronage_timber_slugify(?string $value): ?string {
  if ($value === null || $value === '') {
    return null;
  }
  $slug = strtolower(remove_accents($value));
  $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', $slug), '-');
  return $slug === '' ? null : $slug;
}

/** Trimmed text, or null when empty. */
function patronage_timber_text(mixed $value): ?string {
  $text = is_string($value) ? trim($value) : '';
  return $text === '' ? null : $text;
}

/** Rich text from a WYSIWYG field, or null when it holds no text or embeds. */
function patronage_timber_rich(mixed $value): ?string {
  $html = is_string($value) ? trim($value) : '';
  if ($html === '' || trim(wp_strip_all_tags($html)) === '' && !preg_match('/<(img|iframe|figure|a)\b/i', $html)) {
    return null;
  }
  return $html;
}

/**
 * A site-relative path for links to this site, as the content model wants;
 * other URLs are kept whole.
 */
function patronage_timber_href(string $url): string {
  $home = wp_parse_url(home_url('/'));
  $parts = wp_parse_url($url);
  if (!$parts || !isset($parts['host']) || ($parts['host'] ?? '') !== ($home['host'] ?? '')) {
    return $url;
  }
  if (isset($home['port']) !== isset($parts['port']) || ($home['port'] ?? null) !== ($parts['port'] ?? null)) {
    return $url;
  }
  $path = ($parts['path'] ?? '/') ?: '/';
  return $path . (isset($parts['query']) ? '?' . $parts['query'] : '') . (isset($parts['fragment']) ? '#' . $parts['fragment'] : '');
}

/** An ACF link array (url, title, target) as a content-model Link, or null. */
function patronage_timber_link(mixed $link, mixed $variant = 'primary'): ?array {
  if (!is_array($link) || empty($link['url'])) {
    return null;
  }
  $label = patronage_timber_text($link['title'] ?? null);
  if ($label === null) {
    return null;
  }
  return [
    'label' => $label,
    'href' => patronage_timber_href((string) $link['url']),
    'newTab' => ($link['target'] ?? '') === '_blank',
    'variant' => patronage_timber_one_of(PATRONAGE_TIMBER_LINK_VARIANTS, $variant, 'primary'),
  ];
}

/** The Page Builder `links` repeater: rows of {link, variant}. */
function patronage_timber_links(mixed $rows): array {
  $links = [];
  foreach (is_array($rows) ? $rows : [] as $row) {
    $link = patronage_timber_link($row['link'] ?? null, $row['variant'] ?? 'primary');
    if ($link) {
      $links[] = $link;
    }
  }
  return $links;
}

/** An ACF image (array or attachment ID) as a content-model Image, or null. */
function patronage_timber_image(mixed $image, string $size = 'large'): ?array {
  $id = is_array($image) ? (int) ($image['ID'] ?? $image['id'] ?? 0) : (int) $image;
  if ($id <= 0) {
    return null;
  }
  $src = wp_get_attachment_image_src($id, $size);
  if (!$src) {
    return null;
  }
  return array_filter(
    [
      'id' => $id,
      'src' => $src[0],
      'alt' => (string) get_post_meta($id, '_wp_attachment_image_alt', true),
      'width' => $src[1] ?: null,
      'height' => $src[2] ?: null,
      'srcset' => wp_get_attachment_image_srcset($id, $size) ?: null,
    ],
    fn($value) => $value !== null,
  );
}

/** An image with its caption, as a content-model Media. */
function patronage_timber_media(mixed $image, ?string $caption = null): ?array {
  $resolved = patronage_timber_image($image);
  if (!$resolved) {
    return null;
  }
  $caption ??= patronage_timber_text(wp_get_attachment_caption($resolved['id']) ?: null);
  return array_filter(['image' => $resolved, 'caption' => $caption], fn($value) => $value !== null);
}

/** A layout's section options, with the content model's defaults. */
function patronage_timber_section_options(mixed $options): array {
  $options = is_array($options) ? $options : [];
  return array_filter(
    [
      'skin' => patronage_timber_one_of(PATRONAGE_TIMBER_SKINS, $options['skin'] ?? null, 'light'),
      'width' => patronage_timber_one_of(PATRONAGE_TIMBER_WIDTHS, $options['width'] ?? null, 'default'),
      'paddingTop' => patronage_timber_one_of(PATRONAGE_TIMBER_SPACINGS, $options['padding_top'] ?? null, 'md'),
      'paddingBottom' => patronage_timber_one_of(PATRONAGE_TIMBER_SPACINGS, $options['padding_bottom'] ?? null, 'md'),
      'hidden' => !empty($options['hidden']),
      'slug' => patronage_timber_slugify($options['anchor'] ?? null),
    ],
    fn($value) => $value !== null,
  );
}

/**
 * One Page Builder row as a content-model Block, or null for a row the theme
 * cannot draw (an unknown layout, or one missing its required field).
 */
function patronage_timber_block(array $row, string $id): ?array {
  $layout = $row['acf_fc_layout'] ?? '';
  $copy = fn() => [
    'eyebrow' => patronage_timber_text($row['eyebrow'] ?? null),
    'heading' => patronage_timber_text($row['heading'] ?? null),
    'body' => patronage_timber_rich($row['body'] ?? null),
    'links' => patronage_timber_links($row['links'] ?? null),
  ];

  $block = match ($layout) {
    'content' => [
      'type' => 'content',
      ...$copy(),
      'align' => patronage_timber_one_of(['start', 'center'], $row['align'] ?? null, 'start'),
    ],
    'content_media' => ($media = patronage_timber_media($row['media'] ?? null))
      ? [
        'type' => 'contentMedia',
        ...$copy(),
        'media' => $media,
        'mediaPosition' => patronage_timber_one_of(['start', 'end'], $row['media_position'] ?? null, 'end'),
      ]
      : null,
    'media' => ($media = patronage_timber_media($row['media'] ?? null)) ? ['type' => 'media', 'media' => $media] : null,
    'card_grid' => [
      'type' => 'cardGrid',
      'heading' => patronage_timber_text($row['heading'] ?? null),
      'columns' => (int) patronage_timber_one_of(['2', '3', '4'], (string) ($row['columns'] ?? ''), '3'),
      'cards' => patronage_timber_cards($row['cards'] ?? null, $id),
    ],
    'blockquote' => ($quote = patronage_timber_text($row['quote'] ?? null))
      ? [
        'type' => 'blockquote',
        'quote' => $quote,
        'attribution' => patronage_timber_text($row['attribution'] ?? null),
        'role' => patronage_timber_text($row['role'] ?? null),
        'image' => patronage_timber_image($row['image'] ?? null, 'thumbnail'),
      ]
      : null,
    'call_to_action' => ($heading = patronage_timber_text($row['heading'] ?? null))
      ? [
        'type' => 'callToAction',
        'heading' => $heading,
        'body' => patronage_timber_rich($row['body'] ?? null),
        'links' => patronage_timber_links($row['links'] ?? null),
      ]
      : null,
    'form' => patronage_timber_form_block($row),
    default => null,
  };

  if ($block === null) {
    return null;
  }
  return array_filter(['id' => $id, ...$block], fn($value) => $value !== null);
}

/** Card grid cards; a card without a title is dropped. */
function patronage_timber_cards(mixed $rows, string $id): array {
  $cards = [];
  foreach (is_array($rows) ? $rows : [] as $index => $row) {
    $title = patronage_timber_text($row['title'] ?? null);
    if ($title === null) {
      continue;
    }
    $cards[] = array_filter(
      [
        'id' => "{$id}-{$index}",
        'title' => $title,
        'text' => patronage_timber_text($row['text'] ?? null),
        'image' => patronage_timber_image($row['image'] ?? null, 'medium_large'),
        'link' => patronage_timber_link($row['link'] ?? null, 'text'),
      ],
      fn($value) => $value !== null,
    );
  }
  return $cards;
}

/**
 * The page's sections, hidden ones included (views drop them unless the page
 * is a preview), each as {options, block}.
 */
function patronage_timber_sections(int $post_id): array {
  if (!function_exists('get_field')) {
    return [];
  }
  $sections = [];
  foreach (get_field('sections', $post_id) ?: [] as $index => $row) {
    $block = is_array($row) ? patronage_timber_block($row, "section-{$index}") : null;
    if ($block) {
      $sections[] = [
        'options' => patronage_timber_section_options($row['section_options'] ?? null),
        'block' => $block,
      ];
    }
  }
  return $sections;
}

/** The sections a visitor sees: hidden ones stay for previews only. */
function patronage_timber_visible_sections(array $sections, bool $preview = false): array {
  return $preview ? $sections : array_values(array_filter($sections, fn($section) => !$section['options']['hidden']));
}

/**
 * A page's hero as a content-model Hero, or null without one. A hero with no
 * variant chosen means no hero, and the first section's heading is the <h1>.
 */
function patronage_timber_hero(int $post_id): ?array {
  if (!function_exists('get_field')) {
    return null;
  }
  // The Hero group's fields sit at the top level of the page (WPGraphQL
  // groups them as `hero`).
  $hero = [];
  foreach (['variant', 'title', 'eyebrow', 'skin', 'align', 'subhead', 'body', 'image', 'links'] as $name) {
    $hero[$name] = get_field($name, $post_id);
  }
  $variant = patronage_timber_one_of(PATRONAGE_TIMBER_HERO_VARIANTS, $hero['variant'] ?? null, '');
  if ($variant === '') {
    return null;
  }
  $links = patronage_timber_links($hero['links'] ?? null);
  $image = in_array($variant, ['home', 'split', 'media'], true)
    ? patronage_timber_image($hero['image'] ?? null, 'full')
    : null;

  return array_filter(
    [
      'variant' => $variant,
      'eyebrow' => patronage_timber_text($hero['eyebrow'] ?? null),
      'title' => patronage_timber_text($hero['title'] ?? null) ?? get_the_title($post_id),
      'subhead' => $variant === 'freeform' ? null : patronage_timber_text($hero['subhead'] ?? null),
      'body' => $variant === 'freeform' ? patronage_timber_rich($hero['body'] ?? null) : null,
      'image' => $image,
      'links' => $links,
      'skin' => patronage_timber_one_of(PATRONAGE_TIMBER_SKINS, $hero['skin'] ?? null, 'light'),
      'align' => patronage_timber_one_of(['start', 'center'], $hero['align'] ?? null, 'start'),
    ],
    fn($value) => $value !== null,
  );
}

/** The skin the hero draws with: an image behind the title forces dark. */
function patronage_timber_hero_skin(array $hero): string {
  return $hero['variant'] === 'home' && isset($hero['image']) ? 'dark' : $hero['skin'];
}

/**
 * The options each section renders with. Two sections with the same skin
 * read as one band, so the first drops its bottom padding (the content
 * model's collapsedOptions).
 */
function patronage_timber_collapse(array $sections): array {
  foreach ($sections as $index => $section) {
    $next = $sections[$index + 1] ?? null;
    if ($next && $next['options']['skin'] === $section['options']['skin']) {
      $sections[$index]['options']['paddingBottom'] = 'none';
    }
  }
  return $sections;
}

/**
 * Everything a page view draws: its hero and visible sections, collapsed,
 * with the heading level each section opens with.
 */
function patronage_timber_page(int $post_id, bool $preview = false): array {
  $hero = patronage_timber_hero($post_id);
  $sections = patronage_timber_collapse(
    patronage_timber_visible_sections(patronage_timber_sections($post_id), $preview),
  );
  foreach ($sections as $index => $section) {
    $sections[$index]['headingLevel'] = $index === 0 && $hero === null ? 'h1' : 'h2';
  }
  return [
    'hero' => $hero,
    'heroSkin' => $hero ? patronage_timber_hero_skin($hero) : null,
    'heroJoinsNext' => $hero && isset($sections[0]) && $sections[0]['options']['skin'] === patronage_timber_hero_skin($hero),
    'sections' => $sections,
  ];
}
