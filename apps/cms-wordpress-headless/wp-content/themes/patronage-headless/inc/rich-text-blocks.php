<?php
/**
 * Rich-text blocks: a button, an image, a pullquote and an embed that an
 * editor places in a rich-text field, as `RichTextBlock` in
 * packages/content-model and the Payload app's rich-text blocks describe them.
 *
 * ACF's editors are TinyMCE, so the blocks are shortcodes:
 *
 *   [launch_button url="/apply/" label="Apply" variant="primary" new_tab="1"]
 *   [launch_image id="12" caption="Overrides the image's own caption"]
 *   [launch_pullquote attribution="Rosa Delgado"]Test first.[/launch_pullquote]
 *   [launch_embed url="https://www.youtube.com/watch?v=…" caption="…"]
 *
 * A button can sit inside a paragraph; the others go on a line of their own.
 * WPGraphQL for ACF runs rich-text fields through `the_content`, where each
 * shortcode becomes an element holding the block as JSON in
 * `data-launch-block` (a <span> for a button, so it can sit in a paragraph,
 * and a <div> for the rest, which wpautop leaves unwrapped), and
 * @launch/adapter-wordpress swaps that for @launch/ui's RichTextBlock. A theme
 * that renders its own HTML filters `patronage_headless_rich_text_block_html`
 * and draws the block from the same array.
 */

if (!defined('ABSPATH')) {
  exit();
}

// Rich text keeps the quotes and dashes the editor typed, as Payload's does,
// instead of wptexturize's curly ones. WPGraphQL for ACF runs both filters.
add_action('init', function (): void {
  remove_filter('the_content', 'wptexturize');
  remove_filter('acf_the_content', 'wptexturize');
});

const PATRONAGE_HEADLESS_RICH_TEXT_BLOCKS = ['launch_button', 'launch_image', 'launch_pullquote', 'launch_embed'];

/** Trimmed text, or null when empty. */
function patronage_headless_text(mixed $value): ?string {
  $text = trim(wp_strip_all_tags((string) $value));
  return $text === '' ? null : $text;
}

/** An attachment as the content model's Image, or null. */
function patronage_headless_image_model(int $id): ?array {
  $src = $id ? wp_get_attachment_url($id) : false;
  if (!$src) {
    return null;
  }
  $meta = wp_get_attachment_metadata($id) ?: [];
  return array_filter(
    [
      'src' => $src,
      'alt' => (string) get_post_meta($id, '_wp_attachment_image_alt', true),
      'width' => isset($meta['width']) ? (int) $meta['width'] : null,
      'height' => isset($meta['height']) ? (int) $meta['height'] : null,
    ],
    fn($value) => $value !== null,
  );
}

/**
 * A rich-text block shortcode as the content model's RichTextBlock, or null
 * when it is missing what it needs. Links keep WordPress's absolute URLs; the
 * adapter makes them site-relative.
 */
function patronage_headless_rich_text_block(string $tag, array $atts, ?string $content): ?array {
  switch ($tag) {
    case 'launch_button':
      $url = trim((string) ($atts['url'] ?? ''));
      $label = patronage_headless_text($atts['label'] ?? '');
      if ($url === '' || $label === null) {
        return null;
      }
      $variant = in_array($atts['variant'] ?? '', ['primary', 'secondary', 'text'], true)
        ? $atts['variant']
        : 'primary';
      return [
        'type' => 'button',
        'link' => [
          'href' => str_starts_with($url, '/') ? home_url($url) : $url,
          'label' => $label,
          'newTab' => !empty($atts['new_tab']) && $atts['new_tab'] !== '0',
          'variant' => $variant,
        ],
      ];

    case 'launch_image':
      $id = (int) ($atts['id'] ?? 0);
      $image = patronage_headless_image_model($id);
      if (!$image) {
        return null;
      }
      $caption = patronage_headless_text($atts['caption'] ?? '') ?? patronage_headless_text(wp_get_attachment_caption($id));
      return ['type' => 'image', 'media' => array_filter(['image' => $image, 'caption' => $caption])];

    case 'launch_pullquote':
      $quote = patronage_headless_text($content ?? '');
      if ($quote === null) {
        return null;
      }
      return array_filter([
        'type' => 'pullquote',
        'quote' => $quote,
        'attribution' => patronage_headless_text($atts['attribution'] ?? ''),
      ]);

    case 'launch_embed':
      $url = trim((string) ($atts['url'] ?? ''));
      if (!wp_http_validate_url($url)) {
        return null;
      }
      return array_filter([
        'type' => 'embed',
        'url' => $url,
        'caption' => patronage_headless_text($atts['caption'] ?? ''),
      ]);
  }
  return null;
}

add_action('init', function (): void {
  foreach (PATRONAGE_HEADLESS_RICH_TEXT_BLOCKS as $tag) {
    add_shortcode($tag, function ($atts, $content, $tag): string {
      $block = patronage_headless_rich_text_block($tag, is_array($atts) ? $atts : [], $content);
      if (!$block) {
        return '';
      }
      $tag_name = $block['type'] === 'button' ? 'span' : 'div';
      $html = sprintf(
        '<%1$s data-launch-block="%2$s"></%1$s>',
        $tag_name,
        esc_attr(wp_json_encode($block, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
      );
      return (string) apply_filters('patronage_headless_rich_text_block_html', $html, $block);
    });
  }
});
