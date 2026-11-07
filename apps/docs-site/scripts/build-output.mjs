#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Turn Blume's static build (dist/) into Cloudflare Build Output in
// .cloudflare/output/, the format `cf deploy --prebuilt` and
// `cf previews deploy --prebuilt` upload.
//
//   node scripts/build-output.mjs
//
// The other Workers in this repo get Build Output from the Cloudflare Vite
// plugin. Blume drives its own Astro build, so this does that step with the
// libraries the cf CLI itself uses: it evaluates cloudflare.config.ts and
// writes an assets-only Worker, with no Worker code and no Wrangler config.
import {
  cleanBuildOutputDir,
  writeAssets,
  writeRootConfig,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";

import { loadWorkerConfig, root } from "./worker-config.mjs";

const ctx = {
  isPreview: process.env.CLOUDFLARE_PREVIEW_BUILD === "true",
  mode: "production",
};

const config = await loadWorkerConfig(ctx);

// Blume writes dist/_redirects from blume.config.ts. Add the Composer
// repository's downloads, which `pnpm wp:release` lists in
// composer-redirects.txt: each sends Composer to a zip on a GitHub release.
const redirects = path.join(root, "dist", "_redirects");

const composerRedirects = readFileSync(
  path.join(root, "composer-redirects.txt"),
  "utf-8"
);

appendFileSync(
  redirects,
  `${existsSync(redirects) && !readFileSync(redirects, "utf-8").endsWith("\n") ? "\n" : ""}${composerRedirects}`
);

await cleanBuildOutputDir(root);

await writeAssets({ root, sourceDirectory: path.join(root, "dist") });

await writeWorkerConfig({ config: config.worker, root });

await writeRootConfig(root, config.settings, ctx);

console.log(`Wrote Build Output for ${config.worker.name}`);
