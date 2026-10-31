// Records seeded pages as @launch/adapter-payload's fixtures, read the way
// the front end reads them: `pnpm record-fixture` after `pnpm seed`. The home
// page covers every section block; the starter guide and get involved pages
// cover heroes, rich-text blocks and forms. Timestamps and R2 object keys
// change on every seed, so they are dropped.
import { writeFile } from "node:fs/promises";

import config from "@payload-config";
import { getPayload } from "payload";

import { PAGE_QUERY } from "../src/lib/page-query";

const VOLATILE = new Set(["_objectKey", "createdAt", "updatedAt"]);

const SLUGS = ["home", "guide", "get-involved"] as const;

const payload = await getPayload({ config });

const record = async (slug: (typeof SLUGS)[number]) => {
  const { docs } = await payload.find({
    ...PAGE_QUERY,
    collection: "pages",
    limit: 1,
    overrideAccess: false,
    where: { slug: { equals: slug } },
  });

  const [page] = docs;

  if (!page) {
    throw new Error(`No ${slug} page. Run \`pnpm seed\` first.`);
  }

  const json = JSON.stringify(
    page,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a JSON replacer sees every value in the document.
    (key, value: unknown) => (VOLATILE.has(key) ? undefined : value),
    2
  );

  const file = `packages/adapter-payload/fixtures/${slug}.json`;

  await writeFile(new URL(`../../../${file}`, import.meta.url), `${json}\n`);

  payload.logger.info(`Wrote ${file}`);
};

await Promise.all(SLUGS.map(record));

await payload.destroy();
