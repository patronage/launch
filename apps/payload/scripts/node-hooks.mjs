// Node module hook: resolve `cloudflare:workers` to the Miniflare stand-in.
const target = new URL("cloudflare-workers-node.mjs", import.meta.url).href;

export const resolve = (specifier, context, next) =>
  specifier === "cloudflare:workers"
    ? { shortCircuit: true, url: target }
    : next(specifier, context);
