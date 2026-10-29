<?php
/**
 * Points the editor's Preview button at the front-end's draft-mode route.
 *
 * The link carries a signed, short-lived token instead of the shared secret,
 * so a copied preview link stops working after PATRONAGE_HEADLESS_PREVIEW_TTL
 * seconds and cannot be replayed for another post. The front-end checks the
 * signature with the same HEADLESS_SECRET, then reads the draft over
 * WPGraphQL with an application password.
 */

if (!defined('ABSPATH')) {
  exit();
}

const PATRONAGE_HEADLESS_PREVIEW_TTL = 600;

/** base64url(id.expires).base64url(HMAC-SHA256) */
function patronage_headless_preview_token(int $post_id, int $expires): string {
  $payload = $post_id . '.' . $expires;
  $signature = hash_hmac('sha256', $payload, (string) HEADLESS_SECRET, true);
  return patronage_headless_base64url($payload) . '.' . patronage_headless_base64url($signature);
}

function patronage_headless_base64url(string $value): string {
  return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function patronage_headless_preview_link(WP_Post $post): string {
  $frontend = patronage_headless_frontend_url();
  if ($frontend === '' || !defined('HEADLESS_SECRET') || !HEADLESS_SECRET) {
    return '';
  }
  // Revisions and autosaves preview as their parent.
  $post_id = wp_is_post_revision($post) ?: $post->ID;
  return add_query_arg(
    ['token' => patronage_headless_preview_token((int) $post_id, time() + PATRONAGE_HEADLESS_PREVIEW_TTL)],
    $frontend . '/api/preview/',
  );
}

add_filter(
  'preview_post_link',
  function (string $link, WP_Post $post): string {
    return patronage_headless_preview_link($post) ?: $link;
  },
  10,
  2,
);
