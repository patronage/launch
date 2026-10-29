<?php
/**
 * Seeds invented demo content, run by bin/seed.sh with `wp eval-file`.
 *
 * The pages are the Neighborhood Growers site that the Payload app seeds too:
 * a home page with every Page Builder layout once (plus a hidden section), the
 * pages it links to (get-involved, apply, guide, programs and its two
 * children), an about page, a post, and a draft for trying previews.
 * Images come from packages/demo-content, mounted at /demo-content.
 *
 * Pages that already exist are left alone, so editors' changes survive a
 * rerun. `pnpm --filter cms-wordpress-headless reset` starts from scratch.
 */

if (!defined('WP_CLI') || !WP_CLI) {
  exit();
}

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

const PATRONAGE_SEED_IMAGES = '/demo-content';

/** WordPress's own sample content. */
function patronage_seed_remove_samples(): void {
  foreach (['hello-world', 'sample-page', 'privacy-policy'] as $slug) {
    $posts = get_posts([
      'name' => $slug,
      'post_type' => ['post', 'page'],
      'post_status' => 'any',
      'numberposts' => -1,
    ]);
    foreach ($posts as $post) {
      wp_delete_post($post->ID, true);
    }
  }
}

/**
 * Creates a page or post unless one exists at that path. Returns its ID and
 * whether it was created.
 *
 * @return array{0: int, 1: bool}
 */
function patronage_seed_post(array $post): array {
  $type = $post['post_type'] ?? 'page';
  $parent = $post['post_parent'] ?? 0;
  $path = $parent ? get_page_uri($parent) . '/' . $post['post_name'] : $post['post_name'];
  $existing = get_page_by_path($path, OBJECT, $type);
  if ($existing) {
    return [$existing->ID, false];
  }

  $id = wp_insert_post(
    $post + ['post_type' => $type, 'post_status' => 'publish', 'post_author' => 1],
    true,
  );
  if (is_wp_error($id)) {
    WP_CLI::error("Could not create {$path}: " . $id->get_error_message());
  }
  return [$id, true];
}

/** The attachment ID for a demo image, uploading it once. */
function patronage_seed_image(string $file): int {
  static $images = null;
  if ($images === null) {
    $manifest = PATRONAGE_SEED_IMAGES . '/images.json';
    // A list of {file, alt, caption?}, keyed here by file.
    $list = is_readable($manifest) ? json_decode((string) file_get_contents($manifest), true) : null;
    if (!is_array($list)) {
      WP_CLI::error("Missing or invalid {$manifest}");
    }
    $images = array_column($list, null, 'file');
  }

  $existing = get_posts([
    'post_type' => 'attachment',
    'post_status' => 'inherit',
    'meta_key' => '_patronage_seed_file',
    'meta_value' => $file,
    'fields' => 'ids',
    'numberposts' => 1,
  ]);
  if ($existing) {
    return $existing[0];
  }

  $source = PATRONAGE_SEED_IMAGES . '/images/' . $file;
  if (!is_readable($source)) {
    WP_CLI::error("Missing demo image {$source}");
  }
  $info = $images[$file] ?? [];

  // media_handle_sideload moves the file, so give it a copy.
  $tmp = wp_tempnam($file);
  copy($source, $tmp);
  $id = media_handle_sideload(
    ['name' => $file, 'tmp_name' => $tmp],
    0,
    null,
    ['post_excerpt' => $info['caption'] ?? ''],
  );
  if (is_wp_error($id)) {
    WP_CLI::error("Could not upload {$file}: " . $id->get_error_message());
  }
  update_post_meta($id, '_wp_attachment_image_alt', $info['alt'] ?? '');
  update_post_meta($id, '_patronage_seed_file', $file);
  return $id;
}

function patronage_seed_link(string $title, string $url, bool $new_tab = false): array {
  return ['title' => $title, 'url' => $url, 'target' => $new_tab ? '_blank' : ''];
}

/** A Page Builder row. $options override the content model's defaults. */
function patronage_seed_section(string $layout, array $fields, array $options = []): array {
  return ['acf_fc_layout' => $layout] + $fields + [
    'section_options' => $options + [
      'skin' => 'light',
      'width' => 'default',
      'padding_top' => 'md',
      'padding_bottom' => 'md',
      'anchor' => '',
      'hidden' => 0,
    ],
  ];
}

function patronage_seed_sections(int $id, array $sections): void {
  update_field('sections', $sections, $id);
}

function patronage_seed_hero(int $id, array $hero): void {
  foreach ($hero as $name => $value) {
    update_field($name, $value, $id);
  }
}

function patronage_seed_page(string $slug, string $title, array $sections, int $parent = 0): int {
  [$id, $created] = patronage_seed_post([
    'post_name' => $slug,
    'post_title' => $title,
    'post_parent' => $parent,
  ]);
  if ($created) {
    patronage_seed_sections($id, $sections);
  }
  return $id;
}

/** A short page: one content section. */
function patronage_seed_simple_page(
  string $slug,
  string $title,
  string $eyebrow,
  string $body,
  array $links = [],
  int $parent = 0,
): int {
  return patronage_seed_page(
    $slug,
    $title,
    [
      patronage_seed_section(
        'content',
        ['eyebrow' => $eyebrow, 'heading' => $title, 'body' => $body, 'links' => $links, 'align' => 'start'],
        ['width' => 'narrow', 'padding_top' => 'lg'],
      ),
    ],
    $parent,
  );
}

patronage_seed_remove_samples();
$url = fn(string $path): string => home_url($path);

$home = patronage_seed_page('home', 'Home', [
  patronage_seed_section(
    'content',
    [
      'eyebrow' => 'Neighborhood Growers',
      'heading' => 'Grow food together',
      'body' => '<p>We help neighbors turn empty lots into <strong>shared gardens</strong>.</p>',
      'links' => [
        ['link' => patronage_seed_link('Get involved', $url('/get-involved/')), 'variant' => 'primary'],
        ['link' => patronage_seed_link('Garden map', 'https://maps.example.org/gardens', true), 'variant' => 'secondary'],
      ],
      'align' => 'center',
    ],
    ['skin' => 'accent', 'width' => 'narrow', 'padding_top' => 'lg', 'padding_bottom' => 'lg', 'anchor' => 'Intro'],
  ),
  patronage_seed_section(
    'content_media',
    [
      'eyebrow' => '',
      'heading' => 'How a garden starts',
      'body' =>
        '<ul><li>Find a lot</li><li>Gather <em>five</em> neighbors</li></ul>' .
        '<p>Read <a href="' . esc_url($url('/guide/')) . '">the starter guide</a>.</p>',
      'links' => [],
      'media' => patronage_seed_image('raised-beds.jpg'),
      'media_position' => 'end',
    ],
    ['width' => 'wide'],
  ),
  patronage_seed_section(
    'card_grid',
    [
      'heading' => 'Programs',
      'columns' => '3',
      'cards' => [
        [
          'title' => 'Seed library',
          'text' => 'Borrow seeds in spring, return saved seeds in fall.',
          'image' => patronage_seed_image('seeds.jpg'),
          'link' => patronage_seed_link('Browse seeds', $url('/programs/seed-library/')),
        ],
        [
          'title' => 'Tool share',
          'text' => 'Shovels, wheelbarrows and hoses for every member garden.',
          'image' => patronage_seed_image('tools.jpg'),
          'link' => patronage_seed_link('Reserve a tool', $url('/programs/tool-share/')),
        ],
        ['title' => 'Youth growers', 'text' => 'After-school planting and harvest days.', 'image' => '', 'link' => ''],
      ],
    ],
    ['padding_top' => 'none', 'anchor' => 'programs'],
  ),
  patronage_seed_section(
    'blockquote',
    [
      'quote' => "The garden is the first place on our block where everyone knows each other's names.",
      'attribution' => 'Rosa Delgado',
      'role' => 'Garden lead',
      'image' => patronage_seed_image('portrait.jpg'),
    ],
    ['skin' => 'dark', 'width' => 'narrow', 'padding_top' => 'lg', 'padding_bottom' => 'lg'],
  ),
  patronage_seed_section(
    'media',
    ['media' => patronage_seed_image('harvest.jpg')],
    ['width' => 'full', 'padding_top' => 'none', 'padding_bottom' => 'none'],
  ),
  patronage_seed_section(
    'call_to_action',
    [
      'heading' => 'Start a garden on your block',
      'body' => '<p>We bring soil, seeds and a mentor for the first season.</p>',
      'links' => [['link' => patronage_seed_link('Apply now', $url('/apply/')), 'variant' => 'primary']],
    ],
    ['skin' => 'accent', 'width' => 'narrow', 'anchor' => 'join'],
  ),
  patronage_seed_section(
    'call_to_action',
    ['heading' => 'Winter volunteer drive', 'body' => '', 'links' => []],
    ['hidden' => 1],
  ),
]);

$get_involved = patronage_seed_simple_page(
  'get-involved',
  'Get involved',
  'Volunteer',
  '<p>Join a workday, adopt a bed, or help run the seed library. No experience needed.</p>',
  [['link' => patronage_seed_link('Apply for a garden', $url('/apply/')), 'variant' => 'primary']],
);

$programs = patronage_seed_page('programs', 'Programs', [
  patronage_seed_section(
    'card_grid',
    [
      'heading' => 'Programs',
      'columns' => '2',
      'cards' => [
        [
          'title' => 'Seed library',
          'text' => 'Borrow seeds in spring, return saved seeds in fall.',
          'image' => patronage_seed_image('seeds.jpg'),
          'link' => patronage_seed_link('Browse seeds', $url('/programs/seed-library/')),
        ],
        [
          'title' => 'Tool share',
          'text' => 'Shovels, wheelbarrows and hoses for every member garden.',
          'image' => patronage_seed_image('tools.jpg'),
          'link' => patronage_seed_link('Reserve a tool', $url('/programs/tool-share/')),
        ],
      ],
    ],
    ['padding_top' => 'lg'],
  ),
]);

patronage_seed_simple_page(
  'seed-library',
  'Seed library',
  'Programs',
  '<p>Take a packet in spring and bring back saved seeds after the harvest. Every variety is grown by a member garden.</p>',
  [],
  $programs,
);

patronage_seed_simple_page(
  'tool-share',
  'Tool share',
  'Programs',
  '<p>Member gardens borrow shovels, wheelbarrows and hoses from the shed for up to a week.</p>',
  [],
  $programs,
);

patronage_seed_simple_page(
  'guide',
  'Starter guide',
  'How a garden starts',
  '<p>Find a lot, ask who owns it, and gather five neighbors who can each give two hours a week. We help with the rest.</p>',
  [['link' => patronage_seed_link('Apply now', $url('/apply/')), 'variant' => 'primary']],
);

patronage_seed_simple_page(
  'apply',
  'Apply now',
  'Start a garden',
  '<p>Tell us about the lot and the neighbors who will tend it. We reply within two weeks.</p>',
);

[$about, $about_created] = patronage_seed_post(['post_name' => 'about', 'post_title' => 'About']);
if ($about_created) {
  patronage_seed_hero($about, [
    'eyebrow' => 'About',
    'headline' => 'About Neighborhood Growers',
    'intro' => 'A fictional group that exists only in this demo.',
    'cta' => patronage_seed_link('Read the news', $url('/news/hello-headless/')),
  ]);
  patronage_seed_sections($about, [
    patronage_seed_section(
      'content',
      [
        'heading' => 'What this is',
        'body' => '<p>An invented organisation, used to show a WordPress page with ACF fields rendered by vinext.</p>',
        'links' => [],
        'align' => 'start',
      ],
      ['width' => 'narrow'],
    ),
  ]);
}

patronage_seed_post([
  'post_type' => 'post',
  'post_name' => 'hello-headless',
  'post_title' => 'Hello, headless',
  'post_content' =>
    '<!-- wp:paragraph --><p>A post published in WordPress. Edit it and the front-end revalidates.</p><!-- /wp:paragraph -->',
]);

[$draft, $draft_created] = patronage_seed_post([
  'post_name' => 'coming-soon',
  'post_title' => 'Coming soon',
  'post_status' => 'draft',
]);
if ($draft_created) {
  patronage_seed_sections($draft, [
    patronage_seed_section('content', [
      'heading' => 'Coming soon',
      'body' => '<p>A draft, only visible through Preview.</p>',
      'links' => [],
      'align' => 'start',
    ]),
  ]);
}

update_option('show_on_front', 'page');
update_option('page_on_front', $home);

if (!wp_get_nav_menu_object('primary')) {
  $menu = wp_create_nav_menu('Primary');
  foreach ([$home => 'Home', $programs => 'Programs', $get_involved => 'Get involved', $about => 'About'] as $page => $title) {
    wp_update_nav_menu_item($menu, 0, [
      'menu-item-title' => $title,
      'menu-item-object' => 'page',
      'menu-item-object-id' => $page,
      'menu-item-type' => 'post_type',
      'menu-item-status' => 'publish',
    ]);
  }
  set_theme_mod('nav_menu_locations', ['primary' => $menu] + (array) get_theme_mod('nav_menu_locations'));
}

WP_CLI::success('Seeded demo content.');
