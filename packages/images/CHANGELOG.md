# @patronage/launch-images

## 0.1.2

### Patch Changes

- ef56cfe: The media route can crop: `ar` picks an aspect ratio from a fixed set and `g` the point to keep (`auto`, `face` or a focal point), mapped to the Images binding's `fit: "cover"` and `gravity`. `cropSrc` and `signedCropSrc` build crop URLs, `imageSrcset` offers only the widths a crop fills, and `serveImage` takes `ratios` and an optional `signingKey` that requires signed crops.

## 0.1.1

### Patch Changes

- f1edbf7: `sourcePath` rejects a segment that contains a `/` or `\` of its own.

## 0.1.0

### Minor Changes

- b0bd828: First npm releases. `@patronage/launch-images` (formerly the private `@launch/images`) serves CMS images through the Cloudflare Images binding. `@patronage/launch-logging` publishes the Worker wide-event wrapper and the Cloudflare log-store helpers. `@patronage/launch-wpgraphql` is the framework-neutral WPGraphQL transport taken out of the headless WordPress front-end: Access service token and preview identity, persisted query IDs, Smart Cache tags, typed read errors and `upstream.wordpress` timing.
