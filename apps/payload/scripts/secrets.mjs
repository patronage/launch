#!/usr/bin/env node
// pnpm run secrets [--preview-base] [--dry-run]. See
// packages/worker-scripts/src/secrets.ts.
import path from "node:path";

import { main } from "@launch/worker-scripts/script";
import { setSecrets } from "@launch/worker-scripts/secrets";

const root = path.resolve(import.meta.dirname, "..");

await main(root, setSecrets);
