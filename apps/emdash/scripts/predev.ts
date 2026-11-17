/**
 * Runs before `pnpm dev`: creates .env.local with a random
 * EMDASH_PREVIEW_SECRET the first time, so preview links are signed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const app = path.join(import.meta.dirname, "..");
const envFile = path.join(app, ".env.local");

if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    `EMDASH_PREVIEW_SECRET=${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600 }
  );
}
