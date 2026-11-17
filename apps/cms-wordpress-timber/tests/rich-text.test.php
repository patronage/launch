<?php

declare(strict_types=1);

// The Timber theme's rich-text blocks (inc/rich-text.php) and Twig helpers and
// view choice (inc/render.php), against WordPress, Timber and Twig stubs.
// Like wordpress-shared/patronage-fields/tests/rich-text-blocks.test.php, the
// shortcodes get HTML-encoded attributes ("&" as "&amp;"), as rich text
// delivers them; here they run through the shared shortcode into the
// theme's filter, which hands the block to views/rich-text/block.twig.

namespace Timber {
  /** Records what the theme asks Timber to draw. */
  class Timber {
    /** @var array<int, array{0: string|array, 1: array}> */
    public static array $rendered = [];
    public static ?object $post = null;
    public static function compile(string $view, array $context): string {
      return $view . ' ' . json_encode($context['block'], JSON_UNESCAPED_SLASHES);
    }
    public static function context(): array {
      return ['site' => 'test'];
    }
    public static function get_post(): ?object {
      return self::$post;
    }
    public static function get_posts(): object {
      return new class {
        public function pagination(): array {
          return ['current' => 1];
        }
      };
    }
    public static function render(string|array $views, array $context): void {
      self::$rendered[] = [$views, $context];
    }
  }
}

namespace Twig {
  class Environment {
    /** @var array<string, callable> */
    public array $filters = [];
    /** @var array<string, callable> */
    public array $functions = [];
    public function addFilter(TwigFilter $filter): void {
      $this->filters[$filter->name] = $filter->callable;
    }
    public function addFunction(TwigFunction $function): void {
      $this->functions[$function->name] = $function->callable;
    }
  }
  class TwigFilter {
    public function __construct(public string $name, public mixed $callable = null, public array $options = []) {}
  }
  class TwigFunction {
    public function __construct(public string $name, public mixed $callable = null, public array $options = []) {}
  }
}

namespace {
  define('ABSPATH', __DIR__);

  /** @var array<string, callable[]> */
  $test_hooks = [];
  /** @var array<string, callable> */
  $test_shortcodes = [];
  /** @var array<string, mixed> */
  $test_request = [];
  $test_status = null;

  function add_action(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
    global $test_hooks;
    $test_hooks[$hook][] = $callback;
  }
  function add_filter(string $hook, callable $callback, int $priority = 10, int $accepted_args = 1): void {
    add_action($hook, $callback);
  }
  function apply_filters(string $hook, mixed $value, mixed ...$args): mixed {
    global $test_hooks;
    foreach ($test_hooks[$hook] ?? [] as $callback) {
      $value = $callback($value, ...$args);
    }
    return $value;
  }
  function remove_filter(string $hook, string $callback): void {}
  function add_shortcode(string $tag, callable $callback): void {
    global $test_shortcodes;
    $test_shortcodes[$tag] = $callback;
  }
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
  function esc_attr(string $text): string {
    return htmlspecialchars($text, ENT_QUOTES);
  }
  function wp_json_encode(mixed $value, int $flags = 0): string|false {
    return json_encode($value, $flags);
  }
  function add_query_arg(array $args, string $url): string {
    return $url . '?' . http_build_query($args);
  }
  function remove_accents(string $text): string {
    return $text;
  }
  function get_field(string $name, int $post_id): mixed {
    return null;
  }
  function get_the_title(int $post_id = 0): string {
    return $post_id === 9 ? 'News &amp; notes' : 'Untitled';
  }
  function get_option(string $name): mixed {
    global $test_request;
    return $test_request['options'][$name] ?? false;
  }
  function status_header(int $code): void {
    global $test_status;
    $test_status = $code;
  }
  function get_search_query(): string {
    return 'compost';
  }
  function get_the_archive_title(): string {
    return 'Category: <span>Soil</span>';
  }
  function is_singular(string $type = ''): bool {
    global $test_request;
    return ($test_request['singular'] ?? null) !== null && ($type === '' || $test_request['singular'] === $type);
  }
  function is_preview(): bool {
    return false;
  }
  function is_404(): bool {
    global $test_request;
    return !empty($test_request['404']);
  }
  function is_search(): bool {
    global $test_request;
    return !empty($test_request['search']);
  }
  function is_archive(): bool {
    global $test_request;
    return !empty($test_request['archive']);
  }
  function is_home(): bool {
    global $test_request;
    return !empty($test_request['home']);
  }

  $root = dirname(__DIR__, 3);
  $theme = dirname(__DIR__) . '/wp-content/themes/patronage-timber';
  require $root . '/wordpress-shared/patronage-fields/rich-text-blocks.php';
  require $theme . '/inc/content.php';
  require $theme . '/inc/rich-text.php';
  require $theme . '/inc/render.php';

  foreach ($test_hooks['init'] ?? [] as $init) {
    $init();
  }

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

  /** The block a shortcode hands to the Twig view, or null when it draws nothing. */
  function drawn(string $tag, array $atts, ?string $content = null): ?array {
    global $test_shortcodes;
    $html = ($test_shortcodes[$tag])($atts, $content, $tag);
    if ($html === '') {
      return null;
    }
    [$view, $json] = explode(' ', $html, 2);
    return $view === 'rich-text/block.twig' ? json_decode($json, true) : ['unexpected view' => $view];
  }

  // Rich-text blocks.
  $button = drawn('launch_button', ['url' => '/apply/?a=1&amp;b=2', 'label' => 'Apply &amp; join', 'variant' => 'secondary', 'new_tab' => '1']);
  check(
    'an encoded button draws a site-relative link with its query and a plain-text label',
    $button['link'] ?? null,
    ['href' => '/apply/?a=1&b=2', 'label' => 'Apply & join', 'newTab' => true, 'variant' => 'secondary'],
  );
  check(
    'a button to another site keeps its whole URL',
    drawn('launch_button', ['url' => 'https://example.org/checklist.pdf', 'label' => 'Checklist'])['link']['href'] ?? null,
    'https://example.org/checklist.pdf',
  );
  check('an encoded javascript: URL draws no button', drawn('launch_button', ['url' => '&#106;avascript:alert(1)', 'label' => 'Go']), null);

  $embed = drawn('launch_embed', ['url' => 'https://www.youtube.com/watch?feature=share&amp;v=aqz-KE-bpKQ', 'caption' => 'Tom &amp; Jerry']);
  check('an encoded YouTube URL keeps its query and plays without cookies', $embed['player'] ?? null, ['kind' => 'video', 'src' => 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ']);
  check('an encoded embed caption is plain text', $embed['caption'] ?? null, 'Tom & Jerry');
  check('an http embed is not drawn', drawn('launch_embed', ['url' => 'http://www.youtube.com/watch?v=aqz-KE-bpKQ']), null);
  check('an encoded javascript: embed is not drawn', drawn('launch_embed', ['url' => '&#106;avascript:alert(1)']), null);

  $quote = drawn('launch_pullquote', ['attribution' => 'Rosa &quot;R&quot; Delgado'], 'Test &amp; learn');
  check('a pullquote and its attribution are plain text', [$quote['quote'] ?? null, $quote['attribution'] ?? null], ['Test & learn', 'Rosa "R" Delgado']);

  // Players.
  check('a youtu.be link plays', patronage_timber_player('https://youtu.be/aqz-KE-bpKQ'), ['kind' => 'video', 'src' => 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ']);
  check('a YouTube Short plays', patronage_timber_player('https://www.youtube.com/shorts/aqz-KE-bpKQ')['src'] ?? null, 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ');
  check('a YouTube id that is too short is only a link', patronage_timber_player('https://www.youtube.com/watch?v=abc'), ['kind' => 'link', 'url' => 'https://www.youtube.com/watch?v=abc']);
  check('a YouTube id with markup is only a link', patronage_timber_player('https://www.youtube.com/watch?v=%22%3E%3Cscript%3E')['kind'] ?? null, 'link');
  check('a Vimeo video plays without tracking', patronage_timber_player('https://vimeo.com/76979871'), ['kind' => 'video', 'src' => 'https://player.vimeo.com/video/76979871?dnt=1']);
  check('an unlisted Vimeo video keeps its hash from the path', patronage_timber_player('https://vimeo.com/76979871/abc123')['src'] ?? null, 'https://player.vimeo.com/video/76979871?dnt=1&h=abc123');
  check('an unlisted Vimeo video keeps its hash from the query', patronage_timber_player('https://player.vimeo.com/video/76979871?h=abc123')['src'] ?? null, 'https://player.vimeo.com/video/76979871?dnt=1&h=abc123');
  check('a Vimeo hash that is not hex is left out', patronage_timber_player('https://vimeo.com/76979871/not-a-hash')['src'] ?? null, 'https://player.vimeo.com/video/76979871?dnt=1');
  check('an X post is drawn as a post', patronage_timber_player('https://x.com/launch/status/1234567890'), ['kind' => 'post', 'url' => 'https://x.com/launch/status/1234567890']);
  check('an X profile is only a link', patronage_timber_player('https://x.com/launch')['kind'] ?? null, 'link');
  check('any other https URL is only a link, never framed', patronage_timber_player('https://example.org/video'), ['kind' => 'link', 'url' => 'https://example.org/video']);
  check('a URL without a host is nothing', patronage_timber_player('https:///path'), null);

  // Twig helpers.
  $twig = apply_filters('timber/twig', new \Twig\Environment());
  check('the rich filter prints rich text as it is', ($twig->filters['rich'])('<p>Hi</p>'), '<p>Hi</p>');
  check('the rich filter prints nothing for null', ($twig->filters['rich'])(null), '');
  check('the text filter decodes entities and drops tags', ($twig->filters['text'])('<b>Tom &amp; Jerry&#8217;s</b>'), "Tom & Jerry\u{2019}s");
  check('cx joins class names and drops empty ones', ($twig->functions['cx'])('a', '', ' b ', null, false, 'c'), 'a b c');

  // Which view draws a request.
  function rendered(array $request, ?object $post = null): array {
    global $test_request, $test_status;
    $test_request = $request;
    $test_status = null;
    \Timber\Timber::$rendered = [];
    \Timber\Timber::$post = $post;
    patronage_timber_render();
    return [\Timber\Timber::$rendered[0][0] ?? null, \Timber\Timber::$rendered[0][1] ?? [], $test_status];
  }

  [$views, $context] = rendered(['singular' => 'page'], (object) ['ID' => 1, 'slug' => 'about', 'post_type' => 'page']);
  check('a page draws with its own view first, then page.twig', $views, ['page-about.twig', 'page.twig']);
  check('a page view gets its page model', array_keys($context['page'] ?? []), ['hero', 'heroSkin', 'heroJoinsNext', 'sections']);
  [$views] = rendered(['singular' => 'post'], (object) ['ID' => 2, 'slug' => 'hello', 'post_type' => 'post']);
  check('a post draws with its type view first, then single.twig', $views, ['single-post.twig', 'single.twig']);
  [$views, , $status] = rendered(['404' => true]);
  check('a missing page draws 404.twig with a 404 status', [$views, $status], ['404.twig', 404]);
  [$views, $context] = rendered(['search' => true]);
  check('a search lists results under its query', [$views, $context['title'] ?? null], ['index.twig', "Results for \u{201C}compost\u{201D}"]);
  [, $context] = rendered(['archive' => true]);
  check('an archive lists under its archive title', $context['title'] ?? null, 'Category: <span>Soil</span>');
  [, $context] = rendered(['home' => true, 'options' => ['page_for_posts' => 9]]);
  check('the posts page lists under its page title', $context['title'] ?? null, 'News &amp; notes');
  [, $context] = rendered(['home' => true]);
  check('the news list falls back to News', [$context['title'] ?? null, $context['pagination'] ?? null], ['News', ['current' => 1]]);

  if ($failures > 0) {
    echo "\n{$failures} failed\n";
    exit(1);
  }
  echo "\nall passed\n";
}
