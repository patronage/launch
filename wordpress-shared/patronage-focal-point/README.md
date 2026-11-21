# Patronage Focal Point

A WordPress mu-plugin that exposes each image's focal point in WPGraphQL, so a headless front-end can crop an image to any shape and keep the important part in view: through the `/media` route of [`@patronage/launch-images`](https://launch.patronage.com/references/images), or with CSS `object-position`.

```graphql
fragment Image on MediaItem {
  sourceUrl
  focalPoint {
    x # 0 (left edge) to 1 (right edge)
    y # 0 (top edge) to 1 (bottom edge)
  }
}
```

`focalPoint` is null when no point was picked, and the front-end crops from the center.

## Where the point comes from

WordPress has no focal point of its own, so editors pick one with a plugin. This mu-plugin reads it, in this order:

| Plugin | Meta key | Saved as |
| --- | --- | --- |
| [Media Focus Point](https://wordpress.org/plugins/media-focus-point/) (recommended) | `bg_pos_desktop` | A CSS position, `"45% 34%"` |
| Theia Smart Thumbnails (Premium) | `theiaSmartThumbnails_position` | `[x, y]`, each from 0 to 1 |

Media Focus Point is free, on wordpress.org (install it with Composer from [WordPress Packagist](https://wpackagist.org)), and puts a Focus Point control in the Media Library's attachment details. Theia is read only when Media Focus Point has no point for an image, so a site moving from Theia keeps its existing points until editors set new ones. Media Focus Point deletes its value when an editor centers the point, so on an image that also has a Theia point, centering it in Media Focus Point brings the Theia point back; clear the Theia point too.

Theia also re-cuts WordPress's own crop sizes (such as a square thumbnail) around the point; Media Focus Point does not. That matters only to a front-end that still asks WordPress for a cropped size, such as `sourceUrl(size: THUMBNAIL)`. A front-end that crops the original with `@patronage/launch-images` gets the point from this field with either plugin.

Neither plugin is required: without one, every image resolves to null. A site that stores its point some other way can supply it with the `patronage_focal_point` filter:

```php
add_filter('patronage_focal_point', function (?array $point, int $attachment_id): ?array {
  return $point ?? my_site_focal_point($attachment_id); // ['x' => 0.5, 'y' => 0.3] or null
}, 10, 2);
```

Values outside 0–1 are clamped, and anything that isn't an `x`/`y` pair resolves to null.

## Caching

The point is attachment meta. A page whose HTML or data a front-end caches shows a changed point once that page is revalidated, not when the image is saved.

## Install

Requires WPGraphQL. See [Installing with Composer](../README.md#installing-with-composer).
