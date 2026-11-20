---
"@patronage/launch-images": patch
---

The media route can crop: `ar` picks an aspect ratio from a fixed set and `g` the point to keep (`auto`, `face` or a focal point), mapped to the Images binding's `fit: "cover"` and `gravity`. `cropSrc` and `signedCropSrc` build crop URLs, `imageSrcset` offers only the widths a crop fills, and `serveImage` takes `ratios` and an optional `signingKey` that requires signed crops.
