// Records fixtures/<page>.json from the pages `pnpm --filter
// cms-wordpress-headless seed` creates: fixtures/query.graphql (with the
// fragments it spreads) run against local WordPress, the origin set to
// https://cms.example.com, and, on the home page, one layout the adapter does
// not know, to test that it is skipped.
//
// WordPress runs only registered queries for everyone but administrators, so
// pass an administrator's application password:
//
//   WORDPRESS_ADMIN_AUTH="admin:$(pnpm --silent --filter cms-wordpress-headless wp -- \
//     user application-password create admin fixtures --porcelain)" pnpm record-fixtures
//
// WORDPRESS_URL comes from apps/web-wordpress/.env.local, which `setup` writes.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const root = path.join(import.meta.dirname, "..");
const PAGES = { "get-involved": "/get-involved/", guide: "/guide/", home: "/" };
const FIXTURE_ORIGIN = "https://cms.example.com";

const env = parseEnv(
  readFileSync(path.join(root, "../../apps/web-wordpress/.env.local"), "utf-8")
);

const origin = env.WORDPRESS_URL.replace(/\/+$/u, "");
const auth = process.env.WORDPRESS_ADMIN_AUTH;

if (!auth?.includes(":")) {
  throw new Error("Set WORDPRESS_ADMIN_AUTH to user:application-password.");
}

const authorization = `Basic ${btoa(auth)}`;

const query = ["fixtures/query.graphql", "src/page-builder.graphql"]
  .map((file) => readFileSync(path.join(root, file), "utf-8"))
  .join("\n");

const record = async ([name, uri]) => {
  const response = await fetch(`${origin}/graphql`, {
    body: JSON.stringify({ query, variables: { uri } }),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });

  const { data, errors } = await response.json();

  if (errors?.length || !data?.page) {
    throw new Error(`${uri}: ${JSON.stringify(errors ?? "no page")}`);
  }

  if (name === "home") {
    data.page.pageBuilder.sections.push({
      __typename: "PageBuilderSectionsLegacySliderLayout",
      sectionOptions: null,
    });
  }

  const json = JSON.stringify({ data }, null, 2).replaceAll(
    origin,
    FIXTURE_ORIGIN
  );

  writeFileSync(path.join(root, "fixtures", `${name}.json`), `${json}\n`);
  console.log(`Wrote fixtures/${name}.json`);
};

await Promise.all(Object.entries(PAGES).map(record));
