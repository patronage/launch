/**
 * Image delivery for the vinext front-ends.
 *
 * vinext's `/_next/image` only optimizes files from `public/` on Workers, and
 * CMS media lives elsewhere (WordPress uploads on the CMS host, Payload media
 * in R2). Each app instead mounts a route at `IMAGE_ROUTE` that fetches the
 * original and resizes it with the Cloudflare Images binding. Adapters get
 * `imagePath` through their `imageUrl` option, so the shared UI renders
 * same-origin image URLs without knowing about either CMS, and
 * `imageSrcset` through `imageSrcset`, so browsers fetch only the width a
 * layout needs. SVG and PDF files pass through the same route unresized.
 */

/** The route each app serves images from: `/media/<source path>`. */
export const IMAGE_ROUTE = "/media";

/**
 * The widest image served. Sections top out at the `wide` container width,
 * and `fit: scale-down` never enlarges smaller originals.
 */
export const MAX_IMAGE_WIDTH = 1600;

/**
 * The widths the route resizes to, narrowest first. A fixed set keeps the
 * number of distinct transforms (and cache entries) per image small.
 */
export const IMAGE_WIDTHS = [480, 768, 1024, 1280, MAX_IMAGE_WIDTH] as const;

const ROUTE_WIDTHS: ReadonlySet<number> = new Set(IMAGE_WIDTHS);

/** The query parameter that picks one of `IMAGE_WIDTHS`. */
export const WIDTH_PARAM = "w";

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

/**
 * A `srcset` for an image on the image route: one candidate per width in
 * `IMAGE_WIDTHS` up to the original's `width`, each described by the width
 * the browser will actually get (the route never enlarges). Undefined for
 * anything else (external images, SVG, PDF), which has one size.
 */
export const imageSrcset = (
  src: string,
  width?: number
): string | undefined => {
  if (!(src.startsWith(`${IMAGE_ROUTE}/`) && RASTER_FILE.test(src))) {
    return undefined;
  }

  const separator = src.includes("?") ? "&" : "?";
  const candidates: string[] = [];

  for (const step of IMAGE_WIDTHS) {
    const served = width ? Math.min(step, width) : step;

    candidates.push(`${src}${separator}${WIDTH_PARAM}=${step} ${served}w`);

    if (width && width <= step) {
      break;
    }
  }

  return candidates.join(", ");
};

/** File names the media route serves unresized: SVG and PDF. */
const PASSTHROUGH_FILE = /\.(?:pdf|svg)(?:[?#]|$)/iu;

/** An `<img>` or `<source>` tag; text that only shows one, such as `&lt;img`, isn't. */
const IMAGE_TAG = /<(?:img|source)\b[^>]*>/giu;

/** `src` and `srcset` attributes, with their quoted value. */
const IMAGE_ATTRIBUTE =
  /(?<attribute>\s(?:src|srcset)\s*=\s*)(?<quote>["'])(?<value>.*?)\k<quote>/gisu;

/** An `<a>` tag's opening. */
const LINK_TAG = /<a\b[^>]*>/giu;

/** An `href` attribute, with its quoted value. */
const HREF_ATTRIBUTE =
  /(?<attribute>\shref\s*=\s*)(?<quote>["'])(?<value>.*?)\k<quote>/gisu;

/** Whether the media route serves a URL's file: raster images, SVG and PDF. */
const isMediaFile = (url: string): boolean =>
  RASTER_FILE.test(url) || PASSTHROUGH_FILE.test(url);

/**
 * Like {@link imagePath}, for any file the media route serves (raster
 * images, SVG and PDF), such as a link to an uploaded PDF. Other URLs,
 * including other files under `prefix`, are returned unchanged.
 */
export const mediaPath = (url: string, prefix: string): string =>
  isMediaFile(url) ? imagePath(url, prefix) : url;

/** Rewrites an image attribute's URLs, each candidate's for a srcset. */
const rewriteImageAttribute =
  (prefix: string) =>
  (_match: string, attribute: string, quote: string, value: string) => {
    const rewritten = value
      .split(",")
      .map((candidate) =>
        candidate.replace(/\S+/u, (url) => mediaPath(url, prefix))
      )
      .join(",");

    return `${attribute}${quote}${rewritten}${quote}`;
  };

/** Rewrites a link's `href`. */
const rewriteHref =
  (prefix: string) =>
  (match: string, attribute: string, quote: string, value: string) => {
    const rewritten = mediaPath(value.trim(), prefix);

    return rewritten === value.trim()
      ? match
      : `${attribute}${quote}${rewritten}${quote}`;
  };

/**
 * Points the uploads in CMS-rendered HTML at the media route, as
 * {@link imagePath} does for one URL: each `src`, and each candidate of a
 * `srcset`, of an `<img>` or `<source>` tag, and each link's `href`, that
 * starts with `prefix` and names a file the route serves (a raster image, SVG
 * or PDF). Other files under the prefix, such as video, keep their URLs.
 */
export const rewriteMediaUrls = (html: string, prefix: string): string =>
  html
    .replaceAll(IMAGE_TAG, (tag) =>
      tag.replaceAll(IMAGE_ATTRIBUTE, rewriteImageAttribute(prefix))
    )
    .replaceAll(LINK_TAG, (tag) =>
      tag.replaceAll(HREF_ATTRIBUTE, rewriteHref(prefix))
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

/** Raster formats the Images binding can read. */
const RESIZABLE = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Files served as they are, with the policy each is served under. SVG can
 * carry script, so it gets a sandboxed policy that blocks script, plugins
 * and outside requests even when opened directly. PDF gets none, because
 * Chrome's viewer refuses to render a sandboxed PDF.
 */
const PASSTHROUGH = new Map<string, string | undefined>([
  [
    "image/svg+xml",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  ],
  ["application/pdf", undefined],
]);

const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

/** The width a request asks for: the widest when unset, null when not one of `IMAGE_WIDTHS`. */
const requestedWidth = (request: Request): number | null => {
  const value = new URL(request.url).searchParams.get(WIDTH_PARAM);

  if (value === null) {
    return MAX_IMAGE_WIDTH;
  }

  const width = Number(value);

  return ROUTE_WIDTHS.has(width) && String(width) === value ? width : null;
};

const notFound = () =>
  new Response("Not found", {
    headers: { "cache-control": "no-store" },
    status: 404,
  });

/** An SVG or PDF original, unchanged, under its own content type and policy. */
const passThrough = (body: ReadableStream<Uint8Array>, type: string) => {
  const headers = new Headers({
    "cache-control": CACHE_CONTROL,
    "content-type": type,
    "x-content-type-options": "nosniff",
  });

  const policy = PASSTHROUGH.get(type);

  if (policy) {
    headers.set("content-security-policy", policy);
  }

  return new Response(body, { headers, status: 200 });
};

/**
 * Resizes an original image fetched by the app to the requested width (see
 * `imageSrcset`) and answers the browser. SVG and PDF pass through unresized.
 * Anything else, or a width outside `IMAGE_WIDTHS`, becomes a 404.
 */
export const serveImage = async (
  request: Request,
  original: Response | null,
  images: ImagesBinding
): Promise<Response> => {
  const type = original?.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();

  const width = requestedWidth(request);

  if (!(original?.ok && original.body && type && width)) {
    await original?.body?.cancel();

    return notFound();
  }

  if (PASSTHROUGH.has(type)) {
    return passThrough(original.body, type);
  }

  if (!RESIZABLE.has(type)) {
    await original.body.cancel();

    return notFound();
  }

  const format = negotiateFormat(request.headers.get("accept"));

  const output = await images
    .input(original.body)
    .transform({ fit: "scale-down", width })
    .output({ format, quality: QUALITY });

  const response = output.response();
  const headers = new Headers(response.headers);

  headers.set("cache-control", CACHE_CONTROL);
  headers.set("content-type", format);
  headers.set("vary", "accept");
  headers.set("x-content-type-options", "nosniff");

  return new Response(response.body, { headers, status: 200 });
};
