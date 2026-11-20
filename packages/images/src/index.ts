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
 *
 * A request can also ask for a crop: an aspect ratio (`ar`) and the point to
 * keep (`g`). The route maps these onto the option names Cloudflare uses in
 * every Images interface, `fit: "cover"` and `gravity`, so an editor's focal
 * point survives any ratio or width without pre-cut crop files in the CMS.
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

/** The query parameter that picks one of the allowed aspect ratios, as `3:2`. */
export const RATIO_PARAM = "ar";

/** The query parameter that names the point a crop keeps: `auto`, `face` or `XxY`. */
export const GRAVITY_PARAM = "g";

/** The query parameter that carries a crop's signature, when the route requires one. */
export const SIGNATURE_PARAM = "sig";

/**
 * The aspect ratios the route crops to by default, as `width:height`. A
 * fixed set keeps the number of distinct transforms per image bounded; pass
 * `ratios` to `serveImage` for another set.
 */
export const IMAGE_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "5:6",
  "6:5",
  "16:9",
  "9:16",
  "21:9",
] as const;

const QUALITY = 80;

/**
 * The point a crop keeps, in Cloudflare's own terms: `auto` (saliency),
 * `face`, or coordinates from 0 (left, top) to 1 (right, bottom).
 */
export type Gravity = "auto" | "face" | { x: number; y: number };

/** A crop: the aspect ratio, and the point to keep (the center when unset). */
export interface Crop {
  ratio: string;
  gravity?: Gravity;
}

/** The transform options the route sends to the Images binding. */
export type ImageTransformOptions =
  | { fit: "scale-down"; width: number }
  | {
      fit: "cover";
      gravity?: "auto" | "face" | { mode: "box-center"; x: number; y: number };
      height: number;
      width: number;
    };

/** The parts of the Cloudflare Images binding (`env.IMAGES`) used here. */
export interface ImagesBinding {
  input: (stream: ReadableStream<Uint8Array>) => {
    transform: (options: ImageTransformOptions) => {
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

/** Coordinates are kept to two decimals, so one point has one URL. */
const coordinate = (value: number): string =>
  String(Math.round(Math.min(1, Math.max(0, value)) * 100) / 100);

/** A gravity in the route's (and Cloudflare's URL) form: `auto`, `face` or `0.5x0.3`. */
export const formatGravity = (gravity: Gravity): string =>
  gravity === "auto" || gravity === "face"
    ? gravity
    : `${coordinate(gravity.x)}x${coordinate(gravity.y)}`;

const parseRatio = (ratio: string | null): [number, number] | null => {
  const match = ratio?.match(/^(?<w>[1-9]\d?):(?<h>[1-9]\d?)$/u);

  return match?.groups
    ? [Number(match.groups.w), Number(match.groups.h)]
    : null;
};

/**
 * Adds a crop to an image route URL: the ratio, and the gravity when one is
 * given. The route answers 404 for a ratio outside its set.
 */
export const cropSrc = (src: string, crop: Crop): string => {
  const params = new URLSearchParams({ [RATIO_PARAM]: crop.ratio });

  if (crop.gravity) {
    params.set(GRAVITY_PARAM, formatGravity(crop.gravity));
  }

  return `${src}${src.includes("?") ? "&" : "?"}${params}`;
};

const encoder = new TextEncoder();

/** What a crop signature covers: the path, ratio and gravity, but not the width. */
const signedText = (pathname: string, ratio: string, gravity: string) =>
  `${pathname}\n${ratio}\n${gravity}`;

const signature = async (key: string, text: string): Promise<string> => {
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );

  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmac, encoder.encode(text))
  ).slice(0, 16);

  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
};

/**
 * Like {@link cropSrc}, plus a signature made with `key`, for a route that
 * requires one (`signingKey`). Sign on the server: the key must not reach
 * the browser. The signature leaves the width out, so `imageSrcset` can add
 * widths to a signed URL.
 */
export const signedCropSrc = async (
  src: string,
  crop: Crop,
  key: string
): Promise<string> => {
  const cropped = cropSrc(src, crop);
  const url = new URL(cropped, "https://route.invalid");

  const sig = await signature(
    key,
    signedText(
      url.pathname,
      url.searchParams.get(RATIO_PARAM) ?? "",
      url.searchParams.get(GRAVITY_PARAM) ?? ""
    )
  );

  return `${cropped}&${SIGNATURE_PARAM}=${sig}`;
};

/** The widest crop of `ratio` an original fits without enlarging. */
const cropLimit = (
  ratio: [number, number],
  width?: number,
  height?: number
): number | undefined => {
  const byHeight = height ? Math.floor((height * ratio[0]) / ratio[1]) : null;

  if (width && byHeight) {
    return Math.min(width, byHeight);
  }

  return width ?? byHeight ?? undefined;
};

/** The route widths a crop of an original as wide as `limit` can use, never enlarging past the narrowest. */
const cropWidths = (limit?: number): number[] => {
  const fitting = IMAGE_WIDTHS.filter((step) => !limit || step <= limit);

  return fitting.length > 0 ? fitting : [IMAGE_WIDTHS[0]];
};

/**
 * A `srcset` for an image on the image route: one candidate per width in
 * `IMAGE_WIDTHS` up to the original's `width`, each described by the width
 * the browser will actually get (the route never enlarges). Undefined for
 * anything else (external images, SVG, PDF), which has one size.
 *
 * For a cropped URL (see {@link cropSrc}) it offers only the widths the
 * crop can fill from the original's `width` and `height`, because a cover
 * crop wider than the original would be enlarged.
 */
export const imageSrcset = (
  src: string,
  width?: number,
  height?: number
): string | undefined => {
  if (!(src.startsWith(`${IMAGE_ROUTE}/`) && RASTER_FILE.test(src))) {
    return undefined;
  }

  const separator = src.includes("?") ? "&" : "?";

  const ratio = parseRatio(
    new URL(src, "https://route.invalid").searchParams.get(RATIO_PARAM)
  );

  if (ratio) {
    return cropWidths(cropLimit(ratio, width, height))
      .map((step) => `${src}${separator}${WIDTH_PARAM}=${step} ${step}w`)
      .join(", ");
  }

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

/** A separator inside one decoded segment, such as an encoded `%2F`. */
const SEPARATOR = /[/\\]/u;

/**
 * Joins route segments back into a path, rejecting empty, `.` and `..`
 * segments, and segments with a separator of their own, so a request cannot
 * climb out of the media directory.
 */
export const sourcePath = (segments: readonly string[]): string | null =>
  segments.length > 0 &&
  segments.every(
    (segment) =>
      segment && segment !== "." && segment !== ".." && !SEPARATOR.test(segment)
  )
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

/** Options for {@link serveImage}. */
export interface ServeImageOptions {
  /** The aspect ratios a crop may ask for. Defaults to `IMAGE_RATIOS`. */
  ratios?: readonly string[];
  /**
   * When set, a crop must carry a signature made with this key (see
   * {@link signedCropSrc}), so nobody can run up transforms with ratios and
   * points the site never asked for. Plain resizes need none.
   */
  signingKey?: string;
}

const GRAVITY_POINT = /^(?<x>[01](?:\.\d{1,2})?)x(?<y>[01](?:\.\d{1,2})?)$/u;

/** A gravity from the URL, in its one canonical form, or null. */
const parseGravity = (
  value: string
): Extract<ImageTransformOptions, { fit: "cover" }>["gravity"] | null => {
  if (value === "auto" || value === "face") {
    return value;
  }

  const groups = value.match(GRAVITY_POINT)?.groups;

  if (!groups) {
    return null;
  }

  const x = Number(groups.x);
  const y = Number(groups.y);

  return x <= 1 && y <= 1 && formatGravity({ x, y }) === value
    ? { mode: "box-center", x, y }
    : null;
};

/** Time-constant comparison, so a signature can't be guessed byte by byte. */
const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < a.length; index += 1) {
    // oxlint-disable-next-line no-bitwise -- a constant-time comparison
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }

  return difference === 0;
};

/**
 * The transform a request asks for, or null when it asks for anything the
 * route doesn't serve: a width outside `IMAGE_WIDTHS`, a ratio outside the
 * set, a gravity without a ratio or in a non-canonical form, or (with a
 * `signingKey`) a crop without a valid signature.
 */
export const imageTransform = async (
  request: Request,
  options: ServeImageOptions = {}
): Promise<ImageTransformOptions | null> => {
  const width = requestedWidth(request);
  const url = new URL(request.url);
  const ratioValue = url.searchParams.get(RATIO_PARAM);
  const gravityValue = url.searchParams.get(GRAVITY_PARAM);

  if (!width) {
    return null;
  }

  if (ratioValue === null) {
    return gravityValue === null ? { fit: "scale-down", width } : null;
  }

  const ratio = (options.ratios ?? IMAGE_RATIOS).includes(ratioValue)
    ? parseRatio(ratioValue)
    : null;

  const gravity =
    gravityValue === null ? undefined : parseGravity(gravityValue);

  if (!ratio || gravity === null) {
    return null;
  }

  if (options.signingKey) {
    const expected = await signature(
      options.signingKey,
      signedText(url.pathname, ratioValue, gravityValue ?? "")
    );

    if (!sameText(url.searchParams.get(SIGNATURE_PARAM) ?? "", expected)) {
      return null;
    }
  }

  const height = Math.round((width * ratio[1]) / ratio[0]);

  return gravity
    ? { fit: "cover", gravity, height, width }
    : { fit: "cover", height, width };
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
 * `imageSrcset`), or crops it to the requested ratio around the requested
 * point (see `cropSrc`), and answers the browser. SVG and PDF pass through
 * unresized. Anything else, or a request `imageTransform` refuses, becomes a
 * 404.
 */
export const serveImage = async (
  request: Request,
  original: Response | null,
  images: ImagesBinding,
  options: ServeImageOptions = {}
): Promise<Response> => {
  const type = original?.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();

  const transform = await imageTransform(request, options);

  if (!(original?.ok && original.body && type && transform)) {
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
    .transform(transform)
    .output({ format, quality: QUALITY });

  const response = output.response();
  const headers = new Headers(response.headers);

  headers.set("cache-control", CACHE_CONTROL);
  headers.set("content-type", format);
  headers.set("vary", "accept");
  headers.set("x-content-type-options", "nosniff");

  return new Response(response.body, { headers, status: 200 });
};
