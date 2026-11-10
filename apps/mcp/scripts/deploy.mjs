#!/usr/bin/env node
// pnpm run deploy [--dry-run]. The steps are shared by every Worker; see
// packages/worker-scripts/src/deploy.ts.
import path from "node:path";

import { deploy } from "@launch/worker-scripts/deploy";
import { main } from "@launch/worker-scripts/script";

const root = path.resolve(import.meta.dirname, "..");

// The gateway has no Previews: it serves only on its Access-protected custom
// domain (see cloudflare.config.ts).
await main(root, (ctx) => deploy(ctx, { previews: false, secrets: true }));
