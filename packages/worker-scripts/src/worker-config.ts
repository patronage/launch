/**
 * The Worker's name and bindings live only in the app's cloudflare.config.ts.
 * `vite build` resolves it into Build Output, and the scripts read it from
 * there so names and bindings are never repeated.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ScriptError } from "./script.ts";

export const BUILT_WORKER_CONFIG =
  ".cloudflare/output/v0/workers/default/worker.config.json";

/** Build Output v1, which cf 1.0 release candidates read (Astro's adapter writes it). */
const BUILT_WORKER_CONFIG_V1 =
  ".cloudflare/output/v1/workers/default/worker.config.json";

/** The built config's path: v0 when present, else v1. */
const builtConfigPath = (root: string): string =>
  existsSync(path.join(root, BUILT_WORKER_CONFIG)) ||
  !existsSync(path.join(root, BUILT_WORKER_CONFIG_V1))
    ? BUILT_WORKER_CONFIG
    : BUILT_WORKER_CONFIG_V1;

const workerConfigSchema = z
  .object({
    env: z
      .record(z.string(), z.object({ type: z.string() }).loose())
      .optional(),
    name: z.string(),
  })
  .loose();

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/** What the Workers Builds and secrets scripts need to know about a Worker. */
export interface WorkerSummary {
  name: string;
  secretNames: string[];
}

export const readBuiltWorkerConfig = (root: string): WorkerConfig => {
  const file = builtConfigPath(root);
  let text: string;

  try {
    text = readFileSync(path.join(root, file), "utf-8");
  } catch {
    throw new ScriptError(`Could not read ${file}. Build the app first.`);
  }

  const parsed = workerConfigSchema.safeParse(JSON.parse(text));

  if (!parsed.success) {
    throw new ScriptError(`${file} has no Worker name.`);
  }

  return parsed.data;
};

/** The bindings cloudflare.config.ts declares with `bindings.secret()`. */
export const secretNames = (config: WorkerConfig): string[] =>
  Object.entries(config.env ?? {})
    .filter(([, binding]) => binding.type === "secret")
    .map(([name]) => name);

export const summarize = (config: WorkerConfig): WorkerSummary => ({
  name: config.name,
  secretNames: secretNames(config),
});
