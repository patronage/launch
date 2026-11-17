// Writes every document Payload reads, drafts and versions included, as JSON
// to the file named by its last argument:
// `pnpm payload run scripts/fixtures/dump-content.ts <file>`. The
// D1-to-Postgres e2e test runs it against both databases and compares them.
// (A file, not stdout: the CLI exits before a large write to a pipe drains.)
/* oxlint-disable no-await-in-loop -- Reads one collection at a time, in order. */
import { writeFileSync } from "node:fs";

import config from "@payload-config";
import { getPayload } from "payload";

const payload = await getPayload({ config });
const out = new Map<string, object>();

for (const collection of payload.config.collections) {
  const { slug } = collection;

  if (
    ["payload-kv", "payload-locked-documents", "payload-migrations"].includes(
      slug
    )
  ) {
    continue;
  }

  const { docs } = await payload.find({
    collection: slug,
    depth: 2,
    draft: true,
    limit: 0,
    overrideAccess: true,
    sort: "id",
  });

  out.set(slug, docs);

  if (collection.versions) {
    const versions = await payload.findVersions({
      collection: slug,
      depth: 0,
      limit: 0,
      overrideAccess: true,
      sort: "id",
    });

    out.set(`${slug}:versions`, versions.docs);
  }
}

for (const global of payload.config.globals) {
  out.set(
    `global:${global.slug}`,
    await payload.findGlobal({
      depth: 2,
      draft: true,
      overrideAccess: true,
      slug: global.slug,
    })
  );
}

writeFileSync(
  process.argv.at(-1) ?? "",
  JSON.stringify(Object.fromEntries(out))
);

await payload.destroy();
