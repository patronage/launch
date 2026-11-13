import {
  isThumbnailSrc,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_PIXELS,
} from "./apply";

// The small picture an approval shows beside a file, made with the Cloudflare
// Images binding. The surfaces draw only what `isThumbnailSrc` accepts (a
// small WebP as a `data:` URL), so that is the only thing made here.

// What the Images binding says about a picture, and its thumbnail when one
// small enough could be made.
export interface ImageFacts {
  height: number;
  thumbnail?: string;
  width: number;
}

// The part of the Cloudflare Images binding used here, which an
// `ImagesBinding` satisfies.
export interface ThumbnailImages {
  info: (
    stream: ReadableStream<Uint8Array>
  ) => Promise<{ format: string; height?: number; width?: number }>;
  input: (stream: ReadableStream<Uint8Array>) => {
    transform: (transform: {
      fit: "scale-down";
      height: number;
      width: number;
    }) => {
      output: (options: {
        format: "image/webp";
        quality: number;
      }) => Promise<{ response: () => Response }>;
    };
  };
}

// Tried in order until one fits `THUMBNAIL_MAX_BYTES`: first smaller files of
// the same picture, then a smaller picture.
const ATTEMPTS = [
  { pixels: THUMBNAIL_MAX_PIXELS, quality: 70 },
  { pixels: THUMBNAIL_MAX_PIXELS, quality: 45 },
  { pixels: THUMBNAIL_MAX_PIXELS / 2, quality: 45 },
];

const BASE64_CHUNK = 0x80_00;

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Blob([bytes]).stream();

const toBase64 = (bytes: Uint8Array): string => {
  const parts: string[] = [];

  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    parts.push(
      String.fromCodePoint(...bytes.subarray(start, start + BASE64_CHUNK))
    );
  }

  return btoa(parts.join(""));
};

const attempt = async (
  images: ThumbnailImages,
  bytes: Uint8Array,
  { pixels, quality }: { pixels: number; quality: number }
): Promise<string | undefined> => {
  const output = await images
    .input(streamOf(bytes))
    .transform({ fit: "scale-down", height: pixels, width: pixels })
    .output({ format: "image/webp", quality });

  const response = output.response();
  const made = new Uint8Array(await response.arrayBuffer());

  if (made.byteLength === 0 || made.byteLength > THUMBNAIL_MAX_BYTES) {
    return undefined;
  }

  const src = `data:image/webp;base64,${toBase64(made)}`;

  return isThumbnailSrc(src) ? src : undefined;
};

const firstThatFits = async (
  images: ThumbnailImages,
  bytes: Uint8Array,
  index: number
): Promise<string | undefined> => {
  const settings = ATTEMPTS[index];

  if (!settings) {
    return undefined;
  }

  return (
    (await attempt(images, bytes, settings)) ??
    (await firstThatFits(images, bytes, index + 1))
  );
};

/**
 * Measures a picture and makes its thumbnail. Undefined when there is no
 * Images binding or it cannot read the file as a picture; facts without a
 * thumbnail when none small enough could be made. Never throws: a preview
 * without a picture still shows the file's type, size and hash.
 */
export const describeImage = async (
  images: ThumbnailImages | undefined,
  bytes: Uint8Array
): Promise<ImageFacts | undefined> => {
  if (!images) {
    return undefined;
  }

  let facts: ImageFacts;

  try {
    const info = await images.info(streamOf(bytes));

    // An SVG has no size of its own, and is never drawn here.
    if (info.height === undefined || info.width === undefined) {
      return undefined;
    }

    facts = { height: info.height, width: info.width };
  } catch {
    return undefined;
  }

  try {
    const thumbnail = await firstThatFits(images, bytes, 0);

    if (thumbnail !== undefined) {
      facts.thumbnail = thumbnail;
    }
  } catch {
    // The measurements stand on their own.
  }

  return facts;
};
