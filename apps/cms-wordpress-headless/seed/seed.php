<?php
/**
 * Seeds invented demo content, run by bin/seed.sh with `wp eval-file`.
 *
 * The pages are the Neighborhood Growers site that the Payload app seeds too
 * (apps/payload/src/seed): a home page with every Page Builder layout but the
 * form once (plus a hidden section), the pages it links to with one hero
 * variant each, two Formidable forms placed in form sections, rich-text
 * blocks on the starter guide, and, in WordPress only, an about page, a post
 * and a draft for trying previews.
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

/** A page's hero. $hero overrides the field defaults; fields it leaves out are empty. */
function patronage_seed_hero(int $id, array $hero): void {
  $hero += [
    'title' => '',
    'eyebrow' => '',
    'skin' => 'light',
    'align' => 'start',
    'subhead' => '',
    'body' => '',
    'image' => '',
    'links' => [],
  ];
  foreach ($hero as $name => $value) {
    update_field($name, $value, $id);
  }
}

function patronage_seed_page(string $slug, string $title, array $sections, int $parent = 0, ?array $hero = null): int {
  [$id, $created] = patronage_seed_post([
    'post_name' => $slug,
    'post_title' => $title,
    'post_parent' => $parent,
  ]);
  if ($created) {
    patronage_seed_sections($id, $sections);
    if ($hero) {
      patronage_seed_hero($id, $hero);
    }
  }
  return $id;
}

/** A content section with a heading and one paragraph. */
function patronage_seed_intro(string $heading, string $body): array {
  return patronage_seed_section('content', [
    'eyebrow' => '',
    'heading' => $heading,
    'body' => "<p>{$body}</p>",
    'links' => [],
    'align' => 'start',
  ]);
}

/**
 * Creates a Formidable form with its fields unless one has its key. Field
 * keys start with the form's key, which the theme strips back off (see
 * inc/forms.php). Returns the form ID.
 */
function patronage_seed_form(string $key, string $name, string $submit, string $success, array $fields): int {
  $existing = FrmForm::get_id_by_key($key);
  if ($existing) {
    return (int) $existing;
  }

  $form = FrmForm::create([
    'form_key' => $key,
    'name' => $name,
    'description' => '',
    'status' => 'published',
    'options' => ['submit_value' => $submit, 'success_msg' => $success],
  ]);
  foreach ($fields as $order => $field) {
    $values = FrmFieldsHelper::setup_new_vars($field['type'], $form);
    $values['field_key'] = "{$key}_{$field['name']}";
    $values['name'] = $field['label'];
    $values['required'] = empty($field['required']) ? 0 : 1;
    $values['field_order'] = $order + 1;
    $values['options'] = $field['options'] ?? $values['options'];
    if (isset($field['width'])) {
      $values['field_options']['classes'] = $field['width'];
    }
    FrmField::create($values);
  }
  return (int) $form;
}

/** The Neighborhood Growers forms, as the Payload seed's form-builder forms. */
function patronage_seed_forms(): array {
  // Formidable creates its tables on its first admin request; WP-CLI has none.
  FrmAppController::install();

  $text = fn(string $name, string $label, bool $required = true, string $width = 'frm_full') => [
    'type' => 'text',
    'name' => $name,
    'label' => $label,
    'required' => $required,
    'width' => $width,
  ];
  $email = fn(string $name, string $label) => [
    'type' => 'email',
    'name' => $name,
    'label' => $label,
    'required' => true,
    'width' => 'frm_half',
  ];
  $textarea = fn(string $name, string $label, bool $required = false) => [
    'type' => 'textarea',
    'name' => $name,
    'label' => $label,
    'required' => $required,
  ];
  $select = fn(string $name, string $label, array $options, bool $required = true) => [
    'type' => 'select',
    'name' => $name,
    'label' => $label,
    'options' => $options,
    'required' => $required,
    'width' => 'frm_half',
  ];
  // One box: Formidable saves its one choice when it is ticked.
  $checkbox = fn(string $name, string $label) => [
    'type' => 'checkbox',
    'name' => $name,
    'label' => $label,
    'options' => ['Yes'],
  ];

  return [
    'application' => patronage_seed_form(
      'application',
      'Garden application',
      'Send application',
      'Thanks for applying. A garden mentor will be in touch within two weeks to set up a visit to the lot.',
      [
        $text('name', 'Your name', true, 'frm_half'),
        $email('email', 'Email'),
        $text('lotAddress', 'Lot address or nearest intersection'),
        $select('neighborhood', 'Neighborhood', ['Eastside', 'Mill Creek', 'Riverside', 'Downtown', 'Other']),
        $select('neighbors', 'Neighbors ready to garden', ['1–4', '5–9', '10 or more']),
        $textarea('about', 'Tell us about the lot and who wants to grow there', true),
        $checkbox('permission', "We have, or can get, the owner's permission"),
      ],
    ),
    'volunteer' => patronage_seed_form(
      'volunteer',
      'Volunteer sign-up',
      'Sign up',
      "Thanks for signing up. We'll email you before the next volunteer day.",
      [
        $text('name', 'Your name', true, 'frm_half'),
        $email('email', 'Email'),
        $select('interest', "I'd like to help with", ['Harvest days', 'Mentoring a new garden', 'Seed library', 'Tool share'], false),
        $textarea('note', 'Anything we should know?'),
        $checkbox('newsletter', 'Send me the monthly newsletter'),
      ],
    ),
  ];
}

patronage_seed_remove_samples();
$url = fn(string $path): string => home_url($path);
$forms = patronage_seed_forms();

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

$get_involved = patronage_seed_page(
  'get-involved',
  'Get involved',
  [
    patronage_seed_section('form', [
      'heading' => 'Volunteer with us',
      'body' => "<p>Tell us how you'd like to help and we'll match you with a garden.</p>",
      'form_id' => $forms['volunteer'],
    ]),
    patronage_seed_section(
      'call_to_action',
      [
        'heading' => 'Ready to start?',
        'body' => '',
        'links' => [['link' => patronage_seed_link('Apply now', $url('/apply/')), 'variant' => 'primary']],
      ],
      ['skin' => 'accent', 'width' => 'narrow'],
    ),
  ],
  hero: [
    'variant' => 'split',
    'eyebrow' => 'Volunteer',
    'subhead' => 'Volunteer on a harvest day, mentor a new garden or join the seed library.',
    'image' => patronage_seed_image('harvest.jpg'),
    'links' => [['link' => patronage_seed_link('Sign up below', $url('/get-involved/')), 'variant' => 'primary']],
  ],
);

$programs = patronage_seed_page(
  'programs',
  'Programs',
  [
    patronage_seed_section('card_grid', [
      'heading' => 'Share what we have',
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
    ]),
  ],
  hero: [
    'variant' => 'media',
    'subhead' => 'Shared resources for every member garden, run by volunteers.',
    'image' => patronage_seed_image('tools.jpg'),
  ],
);

patronage_seed_page(
  'seed-library',
  'Seed library',
  [
    patronage_seed_intro(
      'How the library works',
      'Pick up to five packets each spring. In the fall, bring back seed saved from your best plants, labeled with the crop, variety and garden.',
    ),
    patronage_seed_intro(
      'Where to find it',
      'The library lives in the shed at the Elm Street garden, open Saturday mornings from April to October.',
    ),
  ],
  $programs,
  [
    'variant' => 'home',
    'eyebrow' => 'Programs',
    'subhead' => 'Borrow seeds in spring and return saved seeds in fall, so the library grows every year.',
    'image' => patronage_seed_image('seeds.jpg'),
    'skin' => 'dark',
    'links' => [['link' => patronage_seed_link('Start a garden', $url('/apply/')), 'variant' => 'primary']],
  ],
);

// No hero: the page opens with its first section's heading as the <h1>.
patronage_seed_page(
  'tool-share',
  'Tool share',
  [
    patronage_seed_intro(
      'Tool share',
      'Reserve shovels, wheelbarrows and hoses for a work day. Pick up and return at the garden shed.',
    ),
  ],
  $programs,
);

$raised_beds = patronage_seed_image('raised-beds.jpg');
patronage_seed_page(
  'guide',
  'Starter guide',
  [
    patronage_seed_section(
      'content',
      [
        'eyebrow' => '',
        'heading' => 'Test the soil first',
        'body' =>
          '<p>Before anything goes in the ground, send a soil sample to the county extension office. City lots often hold lead from old paint and fuel.</p>' .
          "\n\n" .
          '[launch_pullquote attribution="Rosa Delgado, garden lead"]Test first, plant second. Raised beds fix almost anything the test finds.[/launch_pullquote]' .
          "\n\n" .
          '[launch_image id="' . $raised_beds . '"]' .
          "\n\n" .
          '<p>Once the beds are built, set a watering rota before the first hot week. [launch_button url="/get-involved/" label="Find a mentor" variant="text"]</p>',
        'links' => [],
        'align' => 'start',
      ],
      ['width' => 'narrow'],
    ),
  ],
  hero: [
    'variant' => 'freeform',
    'eyebrow' => 'Starter guide',
    'title' => 'Your first season',
    'align' => 'center',
    'body' =>
      '<p>Everything a new garden needs in its first season, from a <strong>soil test</strong> to a watering rota.</p>' .
      "\n\n" .
      '<p>[launch_button url="/apply/" label="Apply for a garden" variant="primary"] [launch_button url="https://example.org/starter-checklist.pdf" label="Download the checklist" variant="secondary" new_tab="1"]</p>' .
      "\n\n" .
      '[launch_embed url="https://www.youtube.com/watch?v=aqz-KE-bpKQ" caption="A three-minute tour of a first-season garden."]',
  ],
);

patronage_seed_page(
  'apply',
  'Apply now',
  [patronage_seed_section('form', ['heading' => '', 'body' => '', 'form_id' => $forms['application']])],
  hero: [
    'variant' => 'simple',
    'eyebrow' => 'Garden applications',
    'title' => 'Apply for a garden',
    'subhead' => 'Tell us about the lot and the neighbors who want to grow there. We reply within two weeks.',
  ],
);

[$about, $about_created] = patronage_seed_post(['post_name' => 'about', 'post_title' => 'About']);
if ($about_created) {
  patronage_seed_hero($about, [
    'variant' => 'simple',
    'eyebrow' => 'About',
    'title' => 'About Neighborhood Growers',
    'subhead' => 'A fictional group that exists only in this demo.',
    'links' => [['link' => patronage_seed_link('Read the news', $url('/news/hello-headless/')), 'variant' => 'primary']],
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
