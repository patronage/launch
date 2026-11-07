/**
 * Normalizes rendered markup so the two CMSs can be compared:
 * - WordPress HTML arrives as a string and is mounted in a `.l-rich-raw`
 *   wrapper (innerHTML needs an element); Payload's Lexical renders inline.
 * - wpautop leaves newlines between block tags.
 * - React escapes apostrophes in text it renders; injected HTML keeps them.
 */
export const normalizeMarkup = (html: string): string =>
  html
    .replaceAll(
      /<div class="l-rich-raw">(?<inner>[\s\S]*?)<\/div>/gu,
      "$<inner>"
    )
    .replaceAll(/>\s+</gu, "><")
    .replaceAll("&#x27;", "'")
    .trim();
