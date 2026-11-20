# @patronage/launch-images

Serves CMS images from a front-end's own origin through the [Cloudflare Images binding](https://developers.cloudflare.com/images/transform-images/bindings/). vinext's `/_next/image` only resizes files in `public/` on Workers, so CMS media (WordPress uploads, Payload media in R2) goes through one route instead: `/media/<path below the uploads folder>?w=<width>`.

| Export | Use |
| --- | --- |
| `serveImage(request, original, images)` | Resize an original `Response` to the requested width (`IMAGE_WIDTHS`, up to 1600), as AVIF, WebP or JPEG by the browser's `Accept`. SVG and PDF pass through unresized, SVG under a script-free sandbox policy. Anything else, or another width, is a 404. |
| `sourcePath(segments)` | Join route segments into a path, refusing empty, `.` and `..` segments. |
| `imagePath(src, prefix)`, `mediaPath(url, prefix)` | Point a CMS URL below `prefix` at the route. Other URLs are unchanged. |
| `imageSrcset(src, width?, height?)` | A `srcset` with one candidate per width up to the original's. For a cropped URL, only the widths the crop fills without enlarging. |
| `cropSrc(src, { ratio, gravity? })` | Ask the route for a crop: `ar` (one of `IMAGE_RATIOS`, such as `3:2`) and `g` (`auto`, `face`, or a focal point `XxY` from 0 to 1, two decimals). |
| `signedCropSrc(src, crop, key)` | `cropSrc` plus a `sig` the route checks when `serveImage` has a `signingKey`. Server only. |
| `imageTransform(request, options?)` | The binding options a request maps to, or `null` for one the route refuses. `serveImage` uses it. |
| `rewriteMediaUrls(html, prefix)` | Rewrite `src`, `srcset` and link `href`s in CMS-rendered HTML. |

## Use it

```ts
// worker.ts, before handing the request to vinext
import { IMAGE_ROUTE, serveImage, sourcePath } from "@patronage/launch-images";

if (url.pathname.startsWith(`${IMAGE_ROUTE}/`)) {
  const path = sourcePath(
    url.pathname.slice(IMAGE_ROUTE.length + 1).split("/")
  );
  const original = path
    ? await wordpressFetch(`${origin}/wp-content/uploads/${path}`)
    : null;

  return serveImage(request, original, env.IMAGES);
}
```

## Crops and focal points

A crop URL such as `/media/2026/03/a.jpg?ar=3:2&g=0.5x0.3&w=768` becomes the binding's `transform({ width: 768, height: 512, fit: "cover", gravity: { x: 0.5, y: 0.3, mode: "box-center" } })`: the names Cloudflare now uses in every Images interface. The point is centered in the crop as far as the image allows, as WordPress focal-point plugins do when they pre-cut crop sizes, so a CMS can store originals only and let the route cut each ratio and width on request. `gravity` set to `auto` (saliency) or `face` works without a stored point.

Each unique source and transform is billed once a month, so the route only accepts the fixed widths, a fixed set of ratios (`ratios` option, defaulting to `IMAGE_RATIOS`) and points at two decimals. Pass `signingKey` (a Worker secret) to `serveImage` so a crop also needs a signature from `signedCropSrc`, made on the server when the page's data is read. The signature covers the path, ratio and gravity but not the width, so the browser still picks a width from the `srcset`.

```ts
// When reading CMS data, on the server
const src = await signedCropSrc(imagePath(url, prefix), { ratio: "3:2", gravity: focalPoint }, env.IMAGE_SIGNING_KEY);
// In a component
<img src={`${src}&w=768`} srcSet={imageSrcset(src, width, height)} />;
// In the route
return serveImage(request, original, env.IMAGES, { signingKey: env.IMAGE_SIGNING_KEY });
```

The Worker needs an `IMAGES` binding. Fetch originals only from the CMS's uploads path, so the route is not an open proxy. Responses carry `cache-control: public, max-age=86400, stale-while-revalidate=604800`.
