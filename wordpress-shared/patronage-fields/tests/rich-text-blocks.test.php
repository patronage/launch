<?php

declare(strict_types=1);

// The rich-text block shortcodes' attributes against WordPress stubs. Rich
// text reaches them HTML-encoded ("&" as "&amp;"), so each attribute must be
// read as plain text: a URL keeps its query, a label its characters.

define('ABSPATH', __DIR__);

function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {}
function wp_strip_all_tags(string $text): string {
  return trim(strip_tags($text));
}
function wp_parse_url(string $url): array|false {
  return parse_url($url);
}
function home_url(string $path = ''): string {
  return 'https://site.example' . $path;
}
// Stands in for WordPress: keeps http(s) and site paths, drops other protocols.
function esc_url_raw(string $url): string {
  return preg_match('#^(https?://|/)#i', $url) ? $url : '';
}

require dirname(__DIR__) . '/rich-text-blocks.php';

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

$embed = patronage_fields_rich_text_block('launch_embed', ['url' => 'https://www.youtube.com/watch?feature=share&amp;v=aqz-KE-bpKQ', 'caption' => 'Tom &amp; Jerry'], null);
check('an encoded embed URL keeps its query', $embed['url'] ?? null, 'https://www.youtube.com/watch?feature=share&v=aqz-KE-bpKQ');
check('an encoded caption is plain text', $embed['caption'] ?? null, 'Tom & Jerry');

$plain = patronage_fields_rich_text_block('launch_embed', ['url' => 'https://www.youtube.com/watch?feature=share&v=aqz-KE-bpKQ'], null);
check('an unencoded embed URL is unchanged', $plain['url'] ?? null, 'https://www.youtube.com/watch?feature=share&v=aqz-KE-bpKQ');

$button = patronage_fields_rich_text_block('launch_button', ['url' => '/apply/?a=1&amp;b=2', 'label' => 'Apply &amp; join', 'variant' => 'primary'], null);
check('an encoded button URL keeps its query', $button['link']['href'] ?? null, 'https://site.example/apply/?a=1&b=2');
check('an encoded button label is plain text', $button['link']['label'] ?? null, 'Apply & join');

$quote = patronage_fields_rich_text_block('launch_pullquote', ['attribution' => 'Rosa &quot;R&quot; Delgado'], 'Test &amp; learn');
check('a pullquote is plain text', $quote['quote'] ?? null, 'Test & learn');
check('its attribution is plain text', $quote['attribution'] ?? null, 'Rosa "R" Delgado');

check(
  'an encoded javascript: URL is still refused for a button',
  patronage_fields_rich_text_block('launch_button', ['url' => '&#106;avascript:alert(1)', 'label' => 'Go'], null),
  null,
);
check(
  'an encoded javascript: URL is still refused for an embed',
  patronage_fields_rich_text_block('launch_embed', ['url' => '&#106;avascript:alert(1)'], null),
  null,
);
check('markup in a caption stays text, without tags', patronage_fields_text('<b>Bold</b> &lt;i&gt;'), 'Bold <i>');

if ($failures > 0) {
  echo "\n{$failures} failed\n";
  exit(1);
}
echo "\nall passed\n";
