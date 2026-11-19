# @patronage/launch-images

Serves CMS images from a front-end's own origin through the [Cloudflare Images binding](https://developers.cloudflare.com/images/transform-images/bindings/). vinext's `/_next/image` only resizes files in `public/` on Workers, so CMS media (WordPress uploads, Payload media in R2) goes through one route instead: `/media/<path below the uploads folder>?w=<width>`.

| Export | Use |
| --- | --- |
| `serveImage(request, original, images)` | Resize an original `Response` to the requested width (`IMAGE_WIDTHS`, up to 1600), as AVIF, WebP or JPEG by the browser's `Accept`. SVG and PDF pass through unresized, SVG under a script-free sandbox policy. Anything else, or another width, is a 404. |
| `sourcePath(segments)` | Join route segments into a path, refusing empty, `.` and `..` segments. |
| `imagePath(src, prefix)`, `mediaPath(url, prefix)` | Point a CMS URL below `prefix` at the route. Other URLs are unchanged. |
| `imageSrcset(src, width?)` | A `srcset` with one candidate per width up to the original's. |
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

The Worker needs an `IMAGES` binding. Fetch originals only from the CMS's uploads path, so the route is not an open proxy. Responses carry `cache-control: public, max-age=86400, stale-while-revalidate=604800`.
