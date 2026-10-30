import path from "node:path";
import { fileURLToPath } from "node:url";

import { nestedDocsPlugin } from "@payloadcms/plugin-nested-docs";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { r2Storage } from "@payloadcms/storage-r2";
import { env } from "cloudflare:workers";
import { buildConfig } from "payload";

import { Authors } from "./collections/authors";
import { Categories } from "./collections/categories";
import { Media } from "./collections/media";
import { Pages } from "./collections/pages";
import { Posts } from "./collections/posts";
import { Users } from "./collections/users";
import { database } from "./db";
import { SiteSettings } from "./globals/site-settings";

// import.meta.dirname is undefined in workerd, so derive it from the URL.
// oxlint-disable-next-line unicorn/prefer-import-meta-properties
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default buildConfig({
  admin: {
    importMap: {
      baseDir: path.resolve(dirname),
    },
    user: Users.slug,
  },
  collections: [Users, Pages, Posts, Authors, Categories, Media],
  db: await database(),
  editor: lexicalEditor(),
  globals: [SiteSettings],
  plugins: [
    // Child pages get a `parent` and `breadcrumbs`; the last crumb is the path.
    nestedDocsPlugin({
      collections: ["pages"],
      generateLabel: (_, doc) => String(doc.title),
      generateURL: (docs) => docs.map((doc) => `/${String(doc.slug)}`).join(""),
    }),
  ],
  secret: env.PAYLOAD_SECRET || "",
  storage: [
    r2Storage({
      bucket: env.R2,
      collections: { media: true },
    }),
  ],
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
});
