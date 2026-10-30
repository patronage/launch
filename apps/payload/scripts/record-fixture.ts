// Records the seeded home page as @launch/adapter-payload's fixture, read the
// way the front end reads it: `pnpm record-fixture` after `pnpm seed`.
// Timestamps and R2 object keys change on every seed, so they are dropped.
import { writeFile } from "node:fs/promises";

import config from "@payload-config";
import { getPayload } from "payload";

import { PAGE_QUERY } from "../src/lib/page-query";

const VOLATILE = new Set(["_objectKey", "createdAt", "updatedAt"]);

const fixture = new URL(
  "../../../packages/adapter-payload/fixtures/home.json",
  import.meta.url
);

const payload = await getPayload({ config });

const { docs } = await payload.find({
  ...PAGE_QUERY,
  collection: "pages",
  limit: 1,
  overrideAccess: false,
  where: { slug: { equals: "home" } },
});

const [home] = docs;

if (!home) {
  throw new Error("No home page. Run `pnpm seed` first.");
}

const json = JSON.stringify(
  home,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a JSON replacer sees every value in the document.
  (key, value: unknown) => (VOLATILE.has(key) ? undefined : value),
  2
);

await writeFile(fixture, `${json}\n`);

payload.logger.info("Wrote packages/adapter-payload/fixtures/home.json");

await payload.destroy();
