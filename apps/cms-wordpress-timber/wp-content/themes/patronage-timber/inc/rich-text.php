<?php
/**
 * Draws the rich-text blocks (button, image, pullquote, embed) that editors
 * place in rich text as shortcodes. The shortcodes and their block arrays are
 * shared with the headless install (wordpress-shared/patronage-fields); here
 * each block is rendered with views/rich-text/block.twig instead of the
 * headless marker, as @launch/ui's RichTextBlock draws it.
 */

if (!defined('ABSPATH')) {
  exit();
}

add_filter(
  'patronage_fields_rich_text_block_html',
  function (string $html, array $block): string {
    if (($block['type'] ?? '') === 'button') {
      $block['link']['href'] = patronage_timber_href($block['link']['href']);
    }
    if (($block['type'] ?? '') === 'embed') {
      $block['player'] = patronage_timber_player($block['url']);
      if ($block['player'] === null) {
        return '';
      }
    }
    return (string) \Timber\Timber::compile('rich-text/block.twig', ['block' => $block]);
  },
  10,
  2,
);

/**
 * What an embed URL points at, as @launch/ui's playerFor reads it: a YouTube
 * (no-cookie) or Vimeo player, an X post, or a plain link. Other URLs are
 * never framed. Null for anything that is not an https URL.
 */
function patronage_timber_player(string $value): ?array {
  $url = wp_parse_url($value);
  if (!$url || ($url['scheme'] ?? '') !== 'https' || empty($url['host'])) {
    return null;
  }
  $host = strtolower($url['host']);
  $segments = array_values(array_filter(explode('/', $url['path'] ?? ''), 'strlen'));
  parse_str($url['query'] ?? '', $query);

  if (in_array($host, ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'], true)) {
    $id =
      $host === 'youtu.be'
        ? $segments[0] ?? null
        : (is_string($query['v'] ?? null)
          ? $query['v']
          : (in_array($segments[0] ?? '', ['embed', 'shorts', 'live'], true)
            ? $segments[1] ?? null
            : null));
    if (is_string($id) && preg_match('/^[\w-]{6,}$/', $id)) {
      return ['kind' => 'video', 'src' => "https://www.youtube-nocookie.com/embed/{$id}"];
    }
  }

  if (in_array($host, ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'], true)) {
    foreach ($segments as $index => $segment) {
      if (!ctype_digit($segment)) {
        continue;
      }
      // Unlisted videos only play with their privacy hash: /<id>/<hash> or ?h=.
      $hash = is_string($query['h'] ?? null) ? $query['h'] : $segments[$index + 1] ?? null;
      $args = ['dnt' => '1'];
      if (is_string($hash) && preg_match('/^[\da-f]+$/', $hash)) {
        $args['h'] = $hash;
      }
      return ['kind' => 'video', 'src' => add_query_arg($args, "https://player.vimeo.com/video/{$segment}")];
    }
  }

  if (
    in_array($host, ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'], true) &&
    ($segments[1] ?? '') === 'status' &&
    ctype_digit($segments[2] ?? '')
  ) {
    return ['kind' => 'post', 'url' => $value];
  }

  return ['kind' => 'link', 'url' => $value];
}
