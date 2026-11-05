/**
 * Image delivery for the vinext front-ends.
 *
 * vinext's `/_next/image` only optimizes files from `public/` on Workers, and
 * CMS media lives elsewhere (WordPress uploads on the CMS host, Payload media
 * in R2). Each app instead mounts a route at `IMAGE_ROUTE` that fetches the
 * original and resizes it with the Cloudflare Images binding. Adapters get
 * `imagePath` through their `imageUrl` option, so the shared UI renders
 * same-origin image URLs without knowing about either CMS.
 */

/** The route each app serves images from: `/media/<source path>`. */
export const IMAGE_ROUTE = "/media";

/**
 * The widest image served. Sections top out at the `wide` container width,
 * and `fit: scale-down` never enlarges smaller originals.
 */
export const MAX_IMAGE_WIDTH = 1600;

const QUALITY = 80;

/** The parts of the Cloudflare Images binding (`env.IMAGES`) used here. */
export interface ImagesBinding {
  input: (stream: ReadableStream<Uint8Array>) => {
    transform: (options: { fit: "scale-down"; width: number }) => {
      output: (options: { format: OutputFormat; quality: number }) => Promise<{
        response: () => Response;
      }>;
    };
  };
}

export type OutputFormat = "image/avif" | "image/jpeg" | "image/webp";

/**
 * Maps a CMS image URL to the image route, keeping the path below `prefix`.
 * URLs outside `prefix` are returned unchanged, so an external image still
 * renders, just without resizing.
 */
export const imagePath = (src: string, prefix: string): string =>
  src.startsWith(prefix) && src.length > prefix.length
    ? `${IMAGE_ROUTE}/${src.slice(prefix.length).replace(/^\/+/u, "")}`
    : src;

/** File names the media route resizes, by extension. */
const RASTER_FILE = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/iu;

/** An `<img>` or `<source>` tag; text that only shows one, such as `&lt;img`, isn't. */
const IMAGE_TAG = /<(?:img|source)\b[^>]*>/giu;

/** `src` and `srcset` attributes, with their quoted value. */
const IMAGE_ATTRIBUTE =
  /(?<attribute>\s(?:src|srcset)\s*=\s*)(?<quote>["'])(?<value>.*?)\k<quote>/gisu;

/**
 * Points the raster images in CMS-rendered HTML at the media route, as
 * {@link imagePath} does for one URL: each `src`, and each candidate of a
 * `srcset`, of an `<img>` or `<source>` tag that starts with `prefix` and
 * names a raster file. Other files under the prefix (video, PDF, SVG) keep
 * their URLs, since the route refuses them.
 */
export const rewriteImageUrls = (html: string, prefix: string): string =>
  html.replaceAll(IMAGE_TAG, (tag) =>
    tag.replaceAll(
      IMAGE_ATTRIBUTE,
      (_match, attribute: string, quote: string, value: string) => {
        const rewritten = value
          .split(",")
          .map((candidate) =>
            candidate.replace(/\S+/u, (url) =>
              RASTER_FILE.test(url) ? imagePath(url, prefix) : url
            )
          )
          .join(",");

        return `${attribute}${quote}${rewritten}${quote}`;
      }
    )
  );

/**
 * Joins route segments back into a path, rejecting empty, `.` and `..`
 * segments so a request cannot climb out of the media directory.
 */
export const sourcePath = (segments: readonly string[]): string | null =>
  segments.length > 0 &&
  segments.every((segment) => segment && segment !== "." && segment !== "..")
    ? segments.map(encodeURIComponent).join("/")
    : null;

/** AVIF, then WebP, then JPEG, by what the browser accepts. */
export const negotiateFormat = (accept: string | null): OutputFormat => {
  if (accept?.includes("image/avif")) {
    return "image/avif";
  }

  return accept?.includes("image/webp") ? "image/webp" : "image/jpeg";
};

/** Raster formats the Images binding can read. SVG is refused: it can carry script. */
const RESIZABLE = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

const notFound = () =>
  new Response("Not found", {
    headers: { "cache-control": "no-store" },
    status: 404,
  });

/**
 * Resizes an original image fetched by the app and answers the browser.
 * Anything that is not a resizable image becomes a 404.
 */
export const serveImage = async (
  request: Request,
  original: Response | null,
  images: ImagesBinding
): Promise<Response> => {
  const type = original?.headers.get("content-type")?.split(";")[0]?.trim();

  if (!(original?.ok && original.body && type && RESIZABLE.has(type))) {
    await original?.body?.cancel();

    return notFound();
  }

  const format = negotiateFormat(request.headers.get("accept"));

  const output = await images
    .input(original.body)
    .transform({ fit: "scale-down", width: MAX_IMAGE_WIDTH })
    .output({ format, quality: QUALITY });

  const response = output.response();
  const headers = new Headers(response.headers);

  headers.set("cache-control", CACHE_CONTROL);
  headers.set("content-type", format);
  headers.set("vary", "accept");
  headers.set("x-content-type-options", "nosniff");

  return new Response(response.body, { headers, status: 200 });
};
