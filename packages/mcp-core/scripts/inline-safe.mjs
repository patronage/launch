// The approval card's bundle is inlined between <script> tags, so no substring
// of it may close that element or open an HTML comment. Both sequences are
// rewritten into forms JavaScript reads identically. Kept apart from
// `build-approval-card.mjs`, which builds as soon as it loads, so it can be
// tested on its own.
/** @param {string} code The bundled script, as esbuild wrote it. */
export const inlineSafe = (code) =>
  code.replaceAll("</", String.raw`<\/`).replaceAll("<!--", String.raw`<\!--`);
