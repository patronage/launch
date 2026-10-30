<?php
/**
 * Picks the view for each request and adds the theme's Twig helpers.
 */

if (!defined('ABSPATH')) {
  exit();
}

add_filter('timber/twig', function (\Twig\Environment $twig): \Twig\Environment {
  // Rich text WordPress has already filtered (wpautop, shortcodes, kses on save).
  $twig->addFilter(new \Twig\TwigFilter('rich', fn(?string $html): string => (string) $html, ['is_safe' => ['html']]));
  // Joins class names and drops empty ones, like @launch/ui's cn().
  $twig->addFunction(
    new \Twig\TwigFunction('cx', fn(...$classes): string => implode(' ', array_filter(array_map('trim', array_map('strval', $classes))))),
  );
  return $twig;
});

/** Renders the current request with the view that fits it. */
function patronage_timber_render(): void {
  $context = \Timber\Timber::context();

  if (is_singular('page')) {
    $post = \Timber\Timber::get_post();
    $context['post'] = $post;
    $context['page'] = patronage_timber_page($post->ID, is_preview());
    \Timber\Timber::render(['page-' . $post->slug . '.twig', 'page.twig'], $context);
    return;
  }

  if (is_singular()) {
    $post = \Timber\Timber::get_post();
    $context['post'] = $post;
    \Timber\Timber::render(['single-' . $post->post_type . '.twig', 'single.twig'], $context);
    return;
  }

  if (is_404()) {
    status_header(404);
    \Timber\Timber::render('404.twig', $context);
    return;
  }

  $context['posts'] = \Timber\Timber::get_posts();
  $context['title'] = match (true) {
    is_search() => sprintf('Results for “%s”', get_search_query()),
    is_archive() => get_the_archive_title(),
    is_home() && get_option('page_for_posts') => get_the_title((int) get_option('page_for_posts')),
    default => 'News',
  };
  $context['pagination'] = $context['posts']->pagination();
  \Timber\Timber::render('index.twig', $context);
}
