import type { Config } from "payload";

// PAYLOAD_DEMO_LOCALES gives the demo locales, so locale-aware writes can be
// tried against a local Payload: `PAYLOAD_DEMO_LOCALES=en,es`, the first
// being the default locale. Like PAYLOAD_DB it is read when the Worker is
// built (Vite replaces it with a constant) and when the Payload CLI runs.
//
// The deployed demo has one language, and this never changes that. Localized
// fields are stored in tables of their own, so a database migrated without
// the switch cannot serve a build that has it. The switch therefore keeps
// its own local D1, media and migrations under `.demo-locales/`, which is
// not committed (vite.config.ts, scripts/cloudflare-workers-node.mjs and
// src/db.ts), and `pnpm run deploy` refuses to run with it set.
const codes = (process.env.PAYLOAD_DEMO_LOCALES ?? "")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);

/** Where the switch keeps its local state and migrations, from the app. */
export const DEMO_LOCALES_DIR = ".demo-locales";

/** Whether the demo runs with locales. */
export const hasDemoLocales = codes.length > 0;

/**
 * Spread into a field the demo keeps one value of for each locale. A few
 * fields of each kind are: a title, rich text, a field inside a section and
 * one on a file, with their neighbours left shared.
 */
export const demoLocalized = hasDemoLocales
  ? ({ localized: true } as const)
  : {};

export const demoLocalization = (): NonNullable<Config["localization"]> => {
  const [defaultLocale] = codes;

  return defaultLocale
    ? { defaultLocale, fallback: true, locales: [...codes] }
    : false;
};
