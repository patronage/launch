#!/usr/bin/env node
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

await cleanBuildOutputDir(root);

await writeAssets({ root, sourceDirectory: path.join(root, "dist") });

await writeWorkerConfig({ config: config.worker, root });

await writeRootConfig(root, config.settings, ctx);

console.log(`Wrote Build Output for ${config.worker.name}`);
