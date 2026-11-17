// What a file is, read from its first bytes. A caller's own word for a
// file's type (a declared MIME type, a file extension, a response header) is
// never trusted: an upload is checked, previewed and saved as what its bytes
// say it is.

// SVG is recognised so that it can be refused by name: it is a document that
// can carry script, not an image a browser merely paints.
export const SVG_TYPE = "image/svg+xml";

const EXTENSIONS = new Map([
  ["application/pdf", ["pdf"]],
  ["image/avif", ["avif"]],
  ["image/gif", ["gif"]],
  ["image/jpeg", ["jpg", "jpeg"]],
  ["image/png", ["png"]],
  ["image/webp", ["webp"]],
  [SVG_TYPE, ["svg"]],
]);

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCodePoint(...bytes.subarray(start, end));

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length &&
  signature.every((byte, index) => bytes[index] === byte);

// How much of a text file is read to tell whether it is SVG.
const TEXT_PROBE_BYTES = 1024;

const looksLikeSvg = (bytes: Uint8Array): boolean => {
  // The decoder drops a byte order mark, and never throws on bytes that are
  // not text.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, TEXT_PROBE_BYTES))
    .trimStart()
    .toLowerCase();

  return (
    head.startsWith("<svg") ||
    ((head.startsWith("<?xml") || head.startsWith("<!doctype svg")) &&
      head.includes("<svg"))
  );
};

const isAvif = (bytes: Uint8Array): boolean => {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") {
    return false;
  }

  const brand = ascii(bytes, 8, 12);

  return brand === "avif" || brand === "avis";
};

/**
 * The file's type as its bytes show it, or undefined for anything that is
 * not one of the few types these tools handle.
 */
export const sniffFileType = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  const head = bytes.length >= 12 ? ascii(bytes, 0, 6) : "";

  if (head === "GIF87a" || head === "GIF89a") {
    return "image/gif";
  }

  if (head.startsWith("RIFF") && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }

  if (isAvif(bytes)) {
    return "image/avif";
  }

  if (head.startsWith("%PDF-")) {
    return "application/pdf";
  }

  return looksLikeSvg(bytes) ? SVG_TYPE : undefined;
};

/** The file extensions a type goes by, the usual one first. */
export const extensionsFor = (mimeType: string): string[] =>
  EXTENSIONS.get(mimeType) ?? [];

/**
 * Whether a type is one a list of accepted types allows. An entry is a type
 * (`image/png`) or a family (`image/*`); an empty list allows every type.
 */
export const typeAllowed = (mimeType: string, accepted: string[]): boolean =>
  accepted.length === 0 ||
  accepted.some((entry) =>
    entry.endsWith("/*")
      ? mimeType.startsWith(entry.slice(0, -1))
      : entry === mimeType
  );
