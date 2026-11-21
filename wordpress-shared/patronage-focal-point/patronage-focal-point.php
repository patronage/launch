<?php
/**
 * Plugin Name: Patronage Focal Point
 * Description: Exposes each image's focal point in WPGraphQL as MediaItem.focalPoint, read from Media Focus Point or Theia Smart Thumbnails, so a headless front-end can crop around it.
 * Version: 1.0.0
 * Author: Patronage
 *
 * WordPress has no focal point of its own, so an editor picks one with a
 * plugin, and this mu-plugin reads it:
 *
 *   1. Media Focus Point (wordpress.org/plugins/media-focus-point) saves
 *      `bg_pos_desktop` as a CSS position such as "45% 34%".
 *   2. Theia Smart Thumbnails saves `theiaSmartThumbnails_position` as
 *      [x, y], each from 0 to 1. It is read only when Media Focus Point has no
 *      point for the image.
 *
 * Either way the field returns { x, y }, each from 0 (left, top) to 1 (right,
 * bottom), or null when neither plugin has a point, which a front-end treats
 * as the center. The `patronage_focal_point` filter can change or supply the
 * point. Without WPGraphQL the plugin does nothing. See README.md beside this
 * file.
 */

if (!defined('ABSPATH')) {
  exit();
}

const PATRONAGE_FOCAL_POINT_VERSION = '1.0.0';
const PATRONAGE_FOCAL_POINT_MFP_META = 'bg_pos_desktop';
const PATRONAGE_FOCAL_POINT_THEIA_META = 'theiaSmartThumbnails_position';

/** A fraction held to the 0–1 range. */
function patronage_focal_point_clamp(float $value): float {
  return max(0.0, min(1.0, $value));
}

/**
 * A Media Focus Point position ("45% 34%", decimals allowed) as fractions, or
 * null for anything else. The plugin deletes the meta for a centered point,
 * so a missing value is the center.
 *
 * @return array{x: float, y: float}|null
 */
function patronage_focal_point_from_css_position(mixed $value): ?array {
  if (!is_string($value)) {
    return null;
  }
  if (!preg_match('/^\s*(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/', $value, $match)) {
    return null;
  }
  return [
    'x' => patronage_focal_point_clamp((float) $match[1] / 100),
    'y' => patronage_focal_point_clamp((float) $match[2] / 100),
  ];
}

/**
 * A Theia Smart Thumbnails position ([x, y] from 0 to 1, saved as an array or
 * an object) as fractions, or null when it is missing or malformed.
 *
 * @return array{x: float, y: float}|null
 */
function patronage_focal_point_from_pair(mixed $value): ?array {
  if (is_object($value)) {
    $value = (array) $value;
  }
  if (!is_array($value) || count($value) < 2) {
    return null;
  }
  $values = array_values($value);
  if (!is_numeric($values[0]) || !is_numeric($values[1])) {
    return null;
  }
  return [
    'x' => patronage_focal_point_clamp((float) $values[0]),
    'y' => patronage_focal_point_clamp((float) $values[1]),
  ];
}

/**
 * The focal point of an attachment: Media Focus Point's, else Theia's, else
 * null, then passed through the `patronage_focal_point` filter.
 *
 * @return array{x: float, y: float}|null
 */
function patronage_focal_point(int $attachment_id): ?array {
  $point =
    patronage_focal_point_from_css_position(get_post_meta($attachment_id, PATRONAGE_FOCAL_POINT_MFP_META, true)) ??
    patronage_focal_point_from_pair(get_post_meta($attachment_id, PATRONAGE_FOCAL_POINT_THEIA_META, true));

  /**
   * Filters an image's focal point.
   *
   * @param array{x: float, y: float}|null $point         From 0 to 1, or null for the center.
   * @param int                            $attachment_id The image.
   */
  $filtered = apply_filters('patronage_focal_point', $point, $attachment_id);
  if ($filtered === null) {
    return null;
  }
  // A filter can return anything; keep only a well-formed point.
  return is_array($filtered) && isset($filtered['x'], $filtered['y']) && is_numeric($filtered['x']) && is_numeric($filtered['y'])
    ? ['x' => patronage_focal_point_clamp((float) $filtered['x']), 'y' => patronage_focal_point_clamp((float) $filtered['y'])]
    : null;
}

function patronage_focal_point_register_graphql(): void {
  register_graphql_object_type('FocalPoint', [
    'description' => __('The point of an image to keep when it is cropped, as fractions of its width and height.', 'patronage-focal-point'),
    'fields' => [
      'x' => [
        'type' => ['non_null' => 'Float'],
        'description' => __('From 0 (left edge) to 1 (right edge).', 'patronage-focal-point'),
      ],
      'y' => [
        'type' => ['non_null' => 'Float'],
        'description' => __('From 0 (top edge) to 1 (bottom edge).', 'patronage-focal-point'),
      ],
    ],
  ]);

  register_graphql_field('MediaItem', 'focalPoint', [
    'type' => 'FocalPoint',
    'description' => __('The focal point an editor picked for this image, or null when none was picked (crop from the center).', 'patronage-focal-point'),
    'resolve' => fn($media_item) => patronage_focal_point((int) $media_item->databaseId),
  ]);
}
add_action('graphql_register_types', 'patronage_focal_point_register_graphql');
