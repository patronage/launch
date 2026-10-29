// Seeds the local database with the demo site: `pnpm seed` (run `pnpm payload
// migrate` first).
import config from "@payload-config";
import { getPayload } from "payload";

import { seed } from "../src/seed";

const payload = await getPayload({ config });

await seed(payload);

await payload.destroy();
