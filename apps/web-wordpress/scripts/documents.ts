// Writes the GraphQL documents this app sends to the patronage-headless theme's
// graphql-documents.json, which WordPress registers as its only allowed
// persisted queries. `--check` fails when the committed file is stale.
// Reads gql/persisted-documents.json, so run `pnpm codegen` first.
import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../gql/persisted-documents.json", import.meta.url);

const manifest = new URL(
  "../../cms-wordpress-headless/wp-content/themes/patronage-headless/graphql-documents.json",
  import.meta.url
);

const OPERATION_NAME = /\b(?:query|mutation)\s+(?<name>\w+)/u;

const persisted: Record<string, string> = JSON.parse(
  await readFile(source, "utf-8")
);

const documents = Object.entries(persisted)
  .map(([hash, query]) => ({
    id: hash.replace(/^sha256:/u, ""),
    name: OPERATION_NAME.exec(query)?.groups?.name ?? "",
    query,
  }))
  .toSorted((a, b) => a.name.localeCompare(b.name));

const expected = `${JSON.stringify(documents, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(manifest, "utf-8").catch(() => "");

  if (current !== expected) {
    process.stderr.write(
      "graphql-documents.json is stale. Run `pnpm --filter web-wordpress documents` and commit it.\n"
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(manifest, expected);
  process.stdout.write(
    `Wrote ${documents.length} documents to graphql-documents.json\n`
  );
}
